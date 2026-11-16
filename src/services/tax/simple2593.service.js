// backend/src/services/tax/simple2593.service.js
//
// Formulario 2593 — Recibo electrónico del SIMPLE (Resolución DIAN 000081 de
// 2024 y su instructivo). Pitbox NO lo presenta: calcula las casillas de un
// bimestre con la contabilidad para que el contribuyente las copie en el
// servicio informático de la DIAN.
//
// De dónde sale cada sección:
//   Hoja 2 (ICA consolidado por municipio, casillas 84-108): ingresos de las
//     cuentas 4 con el mismo alcance por sede, actividades (CIIU, cuentas) y
//     exclusiones que la pantalla de ICA (services/tax/ica.service.js).
//   Casillas 26-35 (ingresos por grupo del art. 908): los mismos ingresos,
//     cada uno en el grupo SIMPLE de su actividad ICA (ica_activities.simple_group).
//   Casilla 36: tarifa bimestral del grupo según los ingresos en UVT; con
//     varios grupos, la más alta (parágrafo 6 del art. 908).
//   Casilla 45: aportes a pensión del empleador de los periodos de nómina
//     cuya seguridad social se pagó en el bimestre.
//   Casillas 58-59: INC generado (cuenta de sale_tax_inc).
//   Casillas 66, 67, 70: IVA generado, descontable y ReteIVA que le
//     practicaron (cuentas de sale_tax_iva, purchase_iva_descontable y
//     sale_reteiva_receivable).
//   Excedentes del bimestre anterior (46, 51, 60, 69): del recibo anterior
//     del mismo año marcado como presentado; si no hay, se digitan.
// Todas las casillas de valores se aproximan al múltiplo de mil más cercano.

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { getMappedAccountId } = require('../accounting/journalEntry.service');
const { matchActivity, branchScope } = require('./ica.service');

// Tarifas SIMPLE consolidadas BIMESTRALES (parágrafo 4 del art. 908 E.T.,
// tablas del instructivo del 2593). Rangos de ingresos brutos bimestrales en
// UVT: [0, 1.000), [1.000, 2.500), [2.500, 5.000), [5.000, 16.666].
const GROUPS = {
  1: { key: '1', label: 'Grupo 1', name: 'Tiendas pequeñas, minimercados, micromercados y peluquerías', boxes: [26, 27], rates: [1.2, 2.8, 4.4, 5.6] },
  2: { key: '2', label: 'Grupo 2', name: 'Comercio al por mayor y detal, servicios técnicos y mecánicos, talleres, industria y demás actividades', boxes: [28, 29], rates: [1.6, 2.0, 3.5, 4.5] },
  3: { key: '3', label: 'Grupo 3', name: 'Expendio de comidas y bebidas, y transporte', boxes: [30, 31], rates: [3.1, 3.4, 4.0, 4.5] },
  '3p': { key: '3p', label: 'Grupo 3 (sic)', name: 'Servicios profesionales, de consultoría y científicos (predomina el factor intelectual)', boxes: [32, 33], rates: [5.9, 7.3, 12, 14.5] },
  6: { key: '6', label: 'Grupo 6', name: 'Actividades CIIU 4665, 3830 y 3811', boxes: [34, 35], flat: 1.62 },
};
const GROUP_KEYS = ['1', '2', '3', '3p', '6'];
const UVT_LIMITS = [1000, 2500, 5000];
const UVT_MAX = 16666;

// UVT por año (Resoluciones DIAN 000187 de 2023, 000193 de 2024 y 000238 de 2025).
const UVT_BY_YEAR = { 2024: 47065, 2025: 49799, 2026: 52374 };

const PERIODS = {
  1: ['01-01', '02-end', 'Enero – febrero'],
  2: ['03-01', '04-30', 'Marzo – abril'],
  3: ['05-01', '06-30', 'Mayo – junio'],
  4: ['07-01', '08-31', 'Julio – agosto'],
  5: ['09-01', '10-31', 'Septiembre – octubre'],
  6: ['11-01', '12-31', 'Noviembre – diciembre'],
};

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
/** Múltiplo de mil más cercano (instrucción general del formulario). */
const k = (v) => Math.round((Number(v) || 0) / 1000) * 1000;
const pos = (v) => Math.max(0, v);

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function periodRange(year, period) {
  const y = Number(year);
  const p = Number(period);
  if (!Number.isInteger(y) || y < 2024 || y > 2100) throw badRequest('Año inválido (el formulario 2593 aplica desde 2024)');
  if (!PERIODS[p]) throw badRequest('Bimestre inválido (1 a 6)');
  const [from, to, label] = PERIODS[p];
  const febEnd = new Date(Date.UTC(y, 2, 0)).getUTCDate();
  return {
    dateFrom: `${y}-${from}`,
    dateTo: `${y}-${to === '02-end' ? `02-${febEnd}` : to}`,
    label,
  };
}

/** Tarifa bimestral de un grupo para unos ingresos en UVT. */
function groupRate(groupKey, incomeUvt) {
  const g = GROUPS[groupKey];
  if (!g) return 0;
  if (g.flat) return g.flat;
  const tier = UVT_LIMITS.findIndex((limit) => incomeUvt < limit);
  return g.rates[tier === -1 ? 3 : tier];
}

function uvtFor(year, tenantUvt) {
  return UVT_BY_YEAR[year] || Number(tenantUvt) || UVT_BY_YEAR[2026];
}

async function mappedAccountOrNull(tenantId, eventType) {
  try { return await getMappedAccountId(tenantId, eventType); } catch { return null; }
}

/** Movimiento neto de una cuenta mapeada en el bimestre (sign: 'credit' o 'debit'). */
async function accountNet(schema, tenantId, accountId, dateFrom, dateTo, sign) {
  if (!accountId) return { amount: 0, account_id: null };
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(${sign === 'credit' ? 'l.credit - l.debit' : 'l.debit - l.credit'}), 0) AS amount
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE l.account_id = :accountId AND e.tenant_id = :tenantId AND e.status = 'posted'
       AND e.entry_date BETWEEN :dateFrom AND :dateTo AND e.source_type <> 'year_end_close'`,
    { replacements: { accountId, tenantId, dateFrom, dateTo }, type: QueryTypes.SELECT }
  );
  return { amount: round2(row.amount), account_id: accountId };
}

/** INC de las ventas del bimestre: base (ingresos gravados con INC) y valor. */
async function incFromSales(schema, tenantId, dateFrom, dateTo) {
  try {
    const [row] = await sequelize.query(
      `SELECT COALESCE(SUM(si.subtotal), 0) AS base, COALESCE(SUM(si.inc_amount), 0) AS amount
       FROM "${schema}"."sale_items" si
       JOIN "${schema}"."sales" s ON s.id = si.sale_id
       WHERE s.tenant_id = :tenantId AND COALESCE(si.inc_amount, 0) > 0
         AND s.status NOT IN ('cancelled', 'draft')
         AND s.sale_date >= :dateFrom AND s.sale_date < (:dateTo::date + 1)`,
      { replacements: { tenantId, dateFrom, dateTo }, type: QueryTypes.SELECT }
    );
    return { base: round2(row.base), amount: round2(row.amount) };
  } catch {
    return { base: 0, amount: 0 };
  }
}

/** Aportes a pensión del empleador de los periodos cuya seguridad social se pagó en el bimestre. */
async function employerPension(schema, tenantId, dateFrom, dateTo) {
  const accountId = await mappedAccountOrNull(tenantId, 'payroll_employer:pension');
  if (!accountId) return { amount: 0, periods: 0 };
  const [row] = await sequelize.query(
    `WITH paid AS (
       SELECT DISTINCT payroll_period_id
       FROM "${schema}"."payroll_payments"
       WHERE tenant_id = :tenantId AND payment_type = 'social_security' AND status = 'active'
         AND payment_date BETWEEN :dateFrom AND :dateTo
     )
     SELECT COALESCE(SUM(l.debit - l.credit), 0) AS amount, (SELECT COUNT(*) FROM paid)::int AS periods
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE l.account_id = :accountId AND e.tenant_id = :tenantId AND e.status = 'posted'
       AND e.reversed_by_entry_id IS NULL AND e.source_id IN (SELECT payroll_period_id FROM paid)`,
    { replacements: { tenantId, dateFrom, dateTo, accountId }, type: QueryTypes.SELECT }
  ).catch(() => [{ amount: 0, periods: 0 }]);
  return { amount: round2(row.amount), periods: row.periods };
}

// Documentos que facturan o reversan ingreso: lo que llevan a una cuenta de
// ingreso diferido (27...) es ingreso realizado en ese momento (la factura lo realiza).
const BILLING_SOURCES = ['sale', 'credit_note', 'debit_note', 'customer_return'];

/**
 * Cuentas de pasivo de ingresos diferidos -> cuenta de ingreso donde se causan
 * (de los diferidos creados y de la configuración de los productos).
 */
async function deferredAccountMap(schema, tenantId) {
  const rows = await sequelize.query(
    `SELECT DISTINCT ON (x.liability_id) x.liability_id, a.code, a.name
     FROM (
       SELECT liability_account_id AS liability_id, revenue_account_id AS revenue_id, created_at AS at
       FROM "${schema}"."deferred_revenues" WHERE tenant_id = :tenantId
       UNION ALL
       SELECT deferred_account_id, revenue_account_id, updated_at
       FROM "${schema}"."products" WHERE tenant_id = :tenantId AND deferred_account_id IS NOT NULL AND revenue_account_id IS NOT NULL
     ) x JOIN "${schema}"."chart_of_accounts" a ON a.id = x.revenue_id
     ORDER BY x.liability_id, x.at DESC`,
    { replacements: { tenantId }, type: QueryTypes.SELECT }
  ).catch(() => []); // schema sin la tabla todavía (migración pendiente)
  return new Map(rows.map((r) => [r.liability_id, { code: r.code, name: r.name }]));
}

/**
 * Ingresos por municipio (mismo alcance por sede que el ICA), con créditos y
 * débitos por cuenta.
 *
 * Ingresos diferidos (anualidades, semestralidades): en el SIMPLE la factura
 * electrónica realiza el ingreso (art. 28, remitido por el 904 E.T.), así que
 * la anualidad se declara completa en el bimestre en que se factura -aunque
 * se cobre después y contablemente se cause mes a mes-. Por eso se suma lo que las
 * facturas (y sus notas/devoluciones) llevaron a la cuenta del diferido -bajo
 * la cuenta de ingreso donde se causa, para que caiga en su actividad y grupo-
 * y NO se suman las amortizaciones mensuales (source_type deferred_revenue),
 * que contarían el mismo ingreso dos veces.
 */
async function municipalityIncome(schema, tenantId, mun, dateFrom, dateTo, scope) {
  const replacements = { tenantId, dateFrom, dateTo, ...scope.replacements };
  const rows = await sequelize.query(
    `SELECT a.code, a.name, COALESCE(SUM(l.credit), 0) AS credit, COALESCE(SUM(l.debit), 0) AS debit
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     JOIN "${schema}"."chart_of_accounts" a ON a.id = l.account_id
     WHERE e.tenant_id = :tenantId AND e.status = 'posted' AND e.entry_date BETWEEN :dateFrom AND :dateTo
       AND a.account_type = 'ingreso' AND e.source_type NOT IN ('year_end_close', 'deferred_revenue')${scope.sql}
     GROUP BY a.code, a.name ORDER BY a.code`,
    { replacements, type: QueryTypes.SELECT }
  );
  const byCode = new Map(rows.map((r) => [r.code, { code: r.code, name: r.name, credit: round2(r.credit), debit: round2(r.debit) }]));

  const deferred = await deferredAccountMap(schema, tenantId);
  if (deferred.size) {
    const drows = await sequelize.query(
      `SELECT l.account_id, COALESCE(SUM(l.credit), 0) AS credit, COALESCE(SUM(l.debit), 0) AS debit
       FROM "${schema}"."journal_entry_lines" l
       JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
       WHERE e.tenant_id = :tenantId AND e.status = 'posted' AND e.entry_date BETWEEN :dateFrom AND :dateTo
         AND l.account_id IN (:liabilityIds) AND e.source_type IN (:billingSources)${scope.sql}
       GROUP BY l.account_id`,
      { replacements: { ...replacements, liabilityIds: [...deferred.keys()], billingSources: BILLING_SOURCES }, type: QueryTypes.SELECT }
    );
    for (const d of drows) {
      const rev = deferred.get(d.account_id);
      const row = byCode.get(rev.code) || { code: rev.code, name: rev.name, credit: 0, debit: 0 };
      row.credit = round2(row.credit + Number(d.credit));
      row.debit = round2(row.debit + Number(d.debit));
      row.includes_deferred = round2((row.includes_deferred || 0) + Number(d.credit) - Number(d.debit));
      byCode.set(rev.code, row);
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Calcula las dos hojas del 2593 de un bimestre. `inputs` son los valores
 * que se digitan (ver INPUT_FIELDS en el controlador); no escribe nada.
 */
async function compute2593(tenantId, { year, period, inputs = {} }) {
  const { IcaMunicipality, IcaActivity, SimpleReceipt, Tenant } = require('../../models');
  const { dateFrom, dateTo, label } = periodRange(year, period);
  const y = Number(year);
  const p = Number(period);
  const schema = getCurrentSchema() || 'public';
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'tax_config', 'dian_config'] });
  const uvt = uvtFor(y, tenant?.tax_config?.fiscal_profile?.uvt_value);
  const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
  const warnings = [];
  const defaultGroup = GROUP_KEYS.includes(String(inputs.default_group)) ? String(inputs.default_group) : '2';

  // ── Hoja 2: un bloque por municipio activo ──
  const municipalities = await IcaMunicipality.findAll({
    where: { tenant_id: tenantId, is_active: true },
    include: [{ model: IcaActivity, as: 'activities' }],
    order: [['city_name', 'ASC']],
  });
  const groupIncome = Object.fromEntries(GROUP_KEYS.map((g) => [g, 0]));
  const sheet2 = [];
  const munInputs = inputs.municipalities || {};

  for (const mun of municipalities) {
    const activities = mun.activities || [];
    const scope = await branchScope(tenantId, mun);
    const accounts = await municipalityIncome(schema, tenantId, mun, dateFrom, dateTo, scope);
    const mi = munInputs[mun.id] || {};
    const excluded = (mun.excluded_account_prefixes || []).map((x) => String(x).trim()).filter(Boolean);

    let gross = 0;
    let returns = 0;
    let fixedAssets = 0;
    let notTaxed = 0;
    const byActivity = new Map(activities.map((a) => [a.id, { activity: a, base: 0 }]));
    for (const acc of accounts) {
      const net = round2(acc.credit - acc.debit);
      gross += acc.credit;
      returns += acc.debit;
      // Grupo SIMPLE del ingreso: el de su actividad ICA (también los
      // ingresos que el ICA excluye: para el SIMPLE son ingresos brutos).
      const act = matchActivity(acc.code, activities);
      const group = act?.simple_group || defaultGroup;
      if (!act?.simple_group && net) warnings.push(`${mun.city_name}: la cuenta ${acc.code} quedó en el ${GROUPS[defaultGroup].label} (su actividad ICA no tiene grupo SIMPLE).`);
      groupIncome[group] += net;
      if (excluded.some((x) => acc.code.startsWith(x))) {
        // 4245: utilidad en venta de activos fijos (casilla 87); el resto, no gravados (88).
        if (acc.code.startsWith('4245')) fixedAssets += net; else notTaxed += net;
        continue;
      }
      if (!act) { notTaxed += net; continue; }
      byActivity.get(act.id).base += net;
    }

    const c84 = k(gross);
    const c85 = k(returns);
    const c86 = k(num(mi.c86));
    const c87 = k(fixedAssets);
    const c88 = k(notTaxed);
    const c89 = k(num(mi.c89));
    const c90 = pos(c84 - c85 - c86 - c87 - c88 - c89);

    // Actividades gravadas (91-94). Los ingresos exentos/exportaciones que se
    // digitan salen de la actividad principal (la de por defecto).
    const actRows = [...byActivity.values()].map(({ activity: a, base }) => {
      const icaRate = Number(a.rate || 0);
      const consolidated = a.simple_rate != null
        ? Number(a.simple_rate)
        : icaRate * (1 + (mun.avisos_tableros ? Number(mun.avisos_pct || 0) / 100 : 0) + Number(mun.bomberil_pct || 0) / 100);
      return {
        activity_id: a.id, ciiu: a.ciiu_code, description: a.description, is_default: a.is_default,
        simple_group: a.simple_group, rate: round2(consolidated * 10000) / 10000,
        rate_source: a.simple_rate != null ? 'municipio' : 'calculada', base: pos(base),
      };
    });
    const deductions = c86 + c89;
    const main = actRows.find((r) => r.is_default) || actRows[0];
    if (main && deductions) main.base = pos(main.base - deductions);
    if (!actRows.length) warnings.push(`${mun.city_name}: no tiene actividades ICA configuradas.`);
    const rows91 = actRows.map((r) => ({ ...r, c92: k(r.base), c94: k(r.base * r.rate / 1000) }));
    const c95 = rows91.reduce((s, r) => s + r.c94, 0);
    const c96 = k(num(mi.c96));
    const c97 = pos(c95 - c96);
    const c98 = k(num(mi.c98));
    const c99 = pos(c97 - c98);
    const c100 = p === 1 ? k(num(mi.c100)) : 0;
    if (p !== 1 && num(mi.c100)) warnings.push(`${mun.city_name}: las retenciones de ICA anteriores al SIMPLE (casilla 100) solo se registran en el bimestre 1.`);
    const c101 = pos(c99 - c100);
    const c102 = 0;
    const c103 = 0;
    const c104 = pos(c99 + c102 - c100 - c103);
    const c105 = pos(c100 + c103 - c99 - c102);
    const c106 = k(num(mi.c106));
    const informedByTaxpayer = !!mi.rate_informed_by_taxpayer;

    sheet2.push({
      municipality_id: mun.id, city_name: mun.city_name, city_code: mun.city_code,
      department_code: mun.city_code ? String(mun.city_code).slice(0, 2) : null,
      branches: scope.label, accounts,
      boxes: { 84: c84, 85: c85, 86: c86, 87: c87, 88: c88, 89: c89, 90: c90, 95: c95, 96: c96, 97: c97, 98: c98, 99: c99, 100: c100, 101: c101, 102: c102, 103: c103, 104: c104, 105: c105, 106: c106 },
      activities: rows91,
      c107: !informedByTaxpayer,
      c108: informedByTaxpayer,
    });
  }

  // El SIMPLE se liquida sobre TODOS los ingresos del país: lo que no quedó
  // en ningún municipio (sin municipios de ICA, o sedes sin municipio
  // asignado) va al grupo por defecto.
  const allAccounts = await municipalityIncome(schema, tenantId, null, dateFrom, dateTo, { sql: '', replacements: {} });
  const allNet = allAccounts.reduce((s, a) => s + a.credit - a.debit, 0);
  const deferredIncluded = round2(allAccounts.reduce((s, a) => s + (a.includes_deferred || 0), 0));
  if (deferredIncluded) {
    warnings.push(`Incluye ${Math.round(deferredIncluded).toLocaleString('es-CO')} de ingresos recibidos por anticipado (anualidades, semestralidades) facturados en el bimestre: en el SIMPLE el ingreso se realiza al facturar (arts. 28 y 904 E.T.) y se declara completo, aunque la contabilidad lo cause mes a mes. Sus amortizaciones mensuales no se vuelven a sumar.`);
  }
  const inMunicipalities = GROUP_KEYS.reduce((s, g) => s + groupIncome[g], 0);
  const remainder = round2(allNet - inMunicipalities);
  if (!municipalities.length) {
    warnings.push('No hay municipios de ICA configurados (Contabilidad → ICA): la hoja 2 queda vacía y todos los ingresos van al grupo por defecto.');
  } else if (Math.abs(remainder) >= 1) {
    warnings.push(`Hay ingresos por ${Math.round(remainder).toLocaleString('es-CO')} de sedes sin municipio de ICA asignado: van al ${GROUPS[defaultGroup].label} y no aparecen en la hoja 2.`);
  }
  if (Math.abs(remainder) >= 0.01) groupIncome[defaultGroup] += remainder;

  // ── Hoja 1 ──
  const boxes = {};
  const exterior = inputs.exterior || {};
  const groupsPresent = [];
  for (const g of GROUP_KEYS) {
    const [boxCountry, boxAbroad] = GROUPS[g].boxes;
    boxes[boxCountry] = k(pos(groupIncome[g]));
    boxes[boxAbroad] = k(num(exterior[g]));
    if (boxes[boxCountry] || boxes[boxAbroad]) groupsPresent.push(g);
  }
  boxes[37] = sheet2.reduce((s, m) => s + m.boxes[106], 0);
  boxes[38] = k(num(inputs.c38));
  boxes[39] = GROUP_KEYS.reduce((s, g) => s + boxes[GROUPS[g].boxes[0]] + boxes[GROUPS[g].boxes[1]], 0);
  boxes[40] = k(num(inputs.c40));
  boxes[41] = pos(boxes[39] - boxes[40]);

  const incomeUvt = boxes[39] / uvt;
  if (incomeUvt > UVT_MAX) warnings.push(`Los ingresos del bimestre (${Math.round(incomeUvt)} UVT) superan el rango de la tabla (16.666 UVT): se aplica la tarifa más alta del grupo.`);
  const rateByGroup = Object.fromEntries((groupsPresent.length ? groupsPresent : [defaultGroup]).map((g) => [g, groupRate(g, incomeUvt)]));
  const appliedGroup = Object.entries(rateByGroup).sort((a, b) => b[1] - a[1])[0][0];
  boxes[36] = rateByGroup[appliedGroup];
  boxes[42] = k(boxes[41] * boxes[36] / 100);
  boxes[43] = sheet2.reduce((s, m) => s + m.boxes[99], 0);
  boxes[44] = pos(boxes[42] - boxes[43]);

  // Excedentes del bimestre anterior: del recibo presentado del mismo año.
  const previous = p > 1 ? await SimpleReceipt.findOne({ where: { tenant_id: tenantId, year: y, period: p - 1, status: 'presentado' } }) : null;
  const prevBox = (box, inputKey) => {
    if (p === 1) return 0;
    const fromPrev = previous?.result?.sheet1?.boxes?.[box];
    if (fromPrev != null) return Number(fromPrev) || 0;
    return k(num(inputs[inputKey]));
  };
  if (p > 1 && !previous) warnings.push(`No hay un 2593 del bimestre ${p - 1} marcado como presentado: los excedentes del bimestre anterior (casillas 46, 51, 60 y 69) se toman de lo que digites.`);

  const pension = await employerPension(schema, tenantId, dateFrom, dateTo);
  boxes[45] = k(inputs.c45 !== undefined && inputs.c45 !== '' && inputs.c45 !== null ? num(inputs.c45) : pension.amount);
  boxes[46] = prevBox(48, 'prev_c48');
  boxes[47] = Math.min(boxes[45] + boxes[46], boxes[44]);
  boxes[48] = pos(boxes[45] + boxes[46] - boxes[47]);
  boxes[49] = pos(boxes[44] - boxes[47]);

  boxes[50] = p === 1 ? k(num(inputs.c50)) : 0;
  if (p !== 1 && num(inputs.c50)) warnings.push('Las retenciones de renta anteriores al SIMPLE (casilla 50) solo se registran en el bimestre 1.');
  boxes[51] = prevBox(57, 'prev_c57');
  boxes[52] = k(num(inputs.c52));
  boxes[53] = pos(boxes[49] - boxes[50] - boxes[51] - boxes[52]);
  boxes[54] = 0;
  boxes[55] = 0;
  boxes[56] = pos(boxes[49] + boxes[54] - boxes[50] - boxes[51] - boxes[52] - boxes[55]);
  boxes[57] = pos(boxes[50] + boxes[51] + boxes[52] + boxes[55] - boxes[49] - boxes[54]);

  // ── Impuesto nacional al consumo (comidas y bebidas) ──
  // Sin cuenta propia de INC, la contabilidad lo lleva a la del IVA
  // (autoEntries): entonces el valor sale de las ventas y se resta del IVA.
  const incAccount = await mappedAccountOrNull(tenantId, 'sale_tax_inc');
  const incSales = await incFromSales(schema, tenantId, dateFrom, dateTo);
  const incAmount = incAccount ? (await accountNet(schema, tenantId, incAccount, dateFrom, dateTo, 'credit')).amount : incSales.amount;
  boxes[58] = k(incSales.base);
  boxes[59] = k(incAmount);
  boxes[60] = prevBox(65, 'prev_c65');
  boxes[61] = pos(boxes[59] - boxes[60]);
  boxes[62] = 0;
  boxes[63] = 0;
  boxes[64] = pos(boxes[59] + boxes[62] - boxes[60] - boxes[63]);
  boxes[65] = pos(boxes[60] + boxes[63] - boxes[59] - boxes[62]);

  // ── IVA ──
  const [ivaAcc, descAcc, reteIvaAcc] = await Promise.all([
    mappedAccountOrNull(tenantId, 'sale_tax_iva'),
    mappedAccountOrNull(tenantId, 'purchase_iva_descontable'),
    mappedAccountOrNull(tenantId, 'sale_reteiva_receivable'),
  ]);
  const [ivaGen, ivaDesc, reteIva] = await Promise.all([
    accountNet(schema, tenantId, ivaAcc, dateFrom, dateTo, 'credit'),
    accountNet(schema, tenantId, descAcc, dateFrom, dateTo, 'debit'),
    accountNet(schema, tenantId, reteIvaAcc, dateFrom, dateTo, 'debit'),
  ]);
  // Si INC e IVA comparten cuenta (sin mapeo de INC), no contar el INC como IVA.
  boxes[66] = k(pos(ivaGen.amount - (!incAccount || incAccount === ivaAcc ? incSales.amount : 0)));
  boxes[67] = k(pos(ivaDesc.amount));
  boxes[68] = p === 1 ? k(num(inputs.c68)) : 0;
  if (p !== 1 && num(inputs.c68)) warnings.push('El saldo a favor de IVA del año anterior (casilla 68) solo se registra en el bimestre 1.');
  boxes[69] = prevBox(75, 'prev_c75');
  boxes[70] = k(pos(reteIva.amount));
  boxes[71] = pos(boxes[66] - boxes[67] - boxes[68] - boxes[69] - boxes[70]);
  boxes[72] = 0;
  boxes[73] = 0;
  boxes[74] = pos(boxes[66] + boxes[72] - boxes[67] - boxes[68] - boxes[69] - boxes[70] - boxes[73]);
  boxes[75] = pos(boxes[67] + boxes[68] + boxes[69] + boxes[70] + boxes[73] - boxes[66] - boxes[72]);

  // ── Valores a pagar ──
  boxes[76] = sheet2.reduce((s, m) => s + m.boxes[104], 0);
  boxes[77] = boxes[56];
  boxes[78] = boxes[64];
  boxes[79] = boxes[74];
  const totalToPay = boxes[76] + boxes[77] + boxes[78] + boxes[79];

  // Asientos sin contabilizar con ingresos (quedan fuera, igual que en ICA).
  const [drafts] = await sequelize.query(
    `SELECT COUNT(DISTINCT e.id)::int AS n
     FROM "${schema}"."journal_entries" e
     JOIN "${schema}"."journal_entry_lines" l ON l.entry_id = e.id
     JOIN "${schema}"."chart_of_accounts" a ON a.id = l.account_id
     WHERE e.tenant_id = :tenantId AND e.status = 'draft' AND a.account_type = 'ingreso'
       AND e.entry_date BETWEEN :dateFrom AND :dateTo`,
    { replacements: { tenantId, dateFrom, dateTo }, type: QueryTypes.SELECT }
  );
  if (drafts.n) warnings.push(`Hay ${drafts.n} asiento(s) en borrador con ingresos en el bimestre: no se cuentan hasta contabilizarlos.`);
  if (!ivaAcc) warnings.push('No hay cuenta mapeada para el IVA generado (sale_tax_iva): la casilla 66 queda en cero.');

  return {
    year: y,
    period: p,
    period_label: label,
    date_from: dateFrom,
    date_to: dateTo,
    uvt,
    income_uvt: Math.round(incomeUvt * 100) / 100,
    groups: GROUP_KEYS.map((g) => ({ key: g, label: GROUPS[g].label, name: GROUPS[g].name, boxes: GROUPS[g].boxes, rate: groupsPresent.includes(g) ? rateByGroup[g] : null })),
    applied_group: appliedGroup,
    default_group: defaultGroup,
    sources: {
      employer_pension: { amount: pension.amount, periods: pension.periods, overridden: inputs.c45 !== undefined && inputs.c45 !== '' && inputs.c45 !== null },
      iva_generated_account: ivaAcc, iva_deductible_account: descAcc, reteiva_account: reteIvaAcc, inc_account: incAccount,
      previous_receipt: previous ? { id: previous.id, period: previous.period, form_number: previous.form_number } : null,
    },
    sheet1: { boxes, total_to_pay: totalToPay },
    sheet2,
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  compute2593,
  periodRange,
  groupRate,
  GROUPS,
  GROUP_KEYS,
  UVT_BY_YEAR,
};
