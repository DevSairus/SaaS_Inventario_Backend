// backend/src/services/accounting/fiscalReconciliation.service.js
//
// Conciliación fiscal (soporte del formato 2516, art. 772-1 E.T.) e impuesto
// diferido (NIIF para Pymes, sección 29).
//
// Pitbox lleva un solo libro (NIIF). Lo fiscal es un control: parte del
// saldo contable y le suma los ajustes para llegar al valor fiscal.
//
// Lado patrimonial (al 31-dic, o a un corte para el impuesto diferido).
// Ajuste = valor fiscal − valor contable, con el signo natural de la cuenta:
//   - Propiedades, planta y equipo: diferencia del libro fiscal de activos
//     (fixedAssetFiscal.service.js: tope de depreciación del art. 137,
//     deterioro no deducible, costo fiscal propio).
//   - Cartera: la provisión fiscal reemplaza el deterioro NIIF. Método
//     general (5% vencida más de 3 meses, 10% más de 6, 15% más de 1 año) o
//     individual (33% de lo vencido más de 1 año), art. 145 E.T. y
//     Decreto 187 de 1975; o ninguna.
//   - Inventarios: el deterioro por VNR no es deducible hasta que se vende o
//     se da de baja: valor fiscal sin la provisión.
//   - Provisiones (26, salvo 2615 obligaciones fiscales): no deducibles
//     hasta que se pagan (art. 105 E.T.): valor fiscal cero.
//   - Diferencia en cambio no realizada (art. 288 E.T.): lo ajustado con
//     las mediciones NIIF no tiene efecto fiscal hasta que se cobra o paga.
//     Por partida (cuenta + tercero): si al corte su saldo quedó en cero, ya
//     se cobró o pagó y la diferencia se realizó (sale de la conciliación y,
//     por la variación del año, entra a la renta líquida). Si queda saldo, se
//     toma como no realizada toda; un pago parcial lo corrige el contador con
//     un ajuste manual.
//   - Ajustes manuales del contador (temporarios o permanentes).
//
// Lado de renta líquida (año): resultado contable antes de impuestos + la
// variación en el año de cada diferencia temporaria (lo que la contabilidad
// llevó a gasto y fiscalmente aún no se deduce, o al revés) + los ajustes
// permanentes manuales (gastos no deducibles, ingresos no gravados).
//
// Impuesto diferido: cada diferencia temporaria × tarifa. Para un activo,
// valor fiscal > contable es deducible a futuro (activo diferido); para un
// pasivo, al revés. Más las pérdidas fiscales por compensar.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { NIIF_RUBROS, RUBRO_BY_CODE, niifGroupOf } = require('../../data/niifRubros');
const { loadAccounts, sumsByAccount, comprehensiveIncome } = require('./niifStatements.service');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const schemaName = () => getCurrentSchema() || 'public';

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function checkYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Año inválido');
  return y;
}

/* ═════════════════════════════ Parámetros ═════════════════════════════ */

const DEFAULT_SETTINGS = {
  receivable_method: 'general', // 'general' | 'individual' | 'none'
  credit_days: 0, // días de plazo: la cartera está "vencida" desde la factura + este plazo
  tax_rate: 35, // art. 240 E.T., personas jurídicas
  tax_losses: 0, // pérdidas fiscales por compensar al cierre del año
  recognize_dta: true, // reconocer el activo diferido (si no, solo hasta el pasivo diferido)
};

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (!['general', 'individual', 'none'].includes(s.receivable_method)) throw badRequest('Método de provisión fiscal de cartera inválido');
  const num = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${name} fuera de rango`);
    return n;
  };
  return {
    receivable_method: s.receivable_method,
    credit_days: Math.floor(num(s.credit_days, 'Días de plazo', 0, 3650)),
    tax_rate: num(s.tax_rate, 'Tarifa de renta', 0, 100),
    tax_losses: round2(num(s.tax_losses, 'Pérdidas fiscales', 0, 1e15)),
    recognize_dta: s.recognize_dta === true || s.recognize_dta === 'true',
  };
}

async function getSettings(tenantId, year) {
  const [row] = await sequelize.query(
    `SELECT settings FROM "${schemaName()}"."fiscal_reconciliation_settings" WHERE tenant_id = :tenantId AND year = :year`,
    { replacements: { tenantId, year }, type: QueryTypes.SELECT }
  );
  return normalizeSettings(row?.settings || {});
}

async function saveSettings(tenantId, year, raw, userId) {
  const y = checkYear(year);
  const settings = normalizeSettings(raw);
  await sequelize.query(
    `INSERT INTO "${schemaName()}"."fiscal_reconciliation_settings" (tenant_id, year, settings, updated_by)
     VALUES (:tenantId, :year, :settings::jsonb, :userId)
     ON CONFLICT (tenant_id, year) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    { replacements: { tenantId, year: y, settings: JSON.stringify(settings), userId: userId || null } }
  );
  return settings;
}

async function tenantProfile(tenantId) {
  const [t] = await sequelize.query(
    `SELECT business_config, tax_config FROM "public"."tenants" WHERE id = :tenantId`,
    { replacements: { tenantId }, type: QueryTypes.SELECT }
  );
  return {
    niif_group: niifGroupOf(t || {}),
    is_simple: t?.tax_config?.fiscal_profile?.regime === 'simple',
  };
}

/* ═════════════════════════════ Ajustes manuales ═════════════════════════════ */

async function listAdjustments(tenantId, year) {
  return sequelize.query(
    `SELECT f.id, f.year, f.statement, f.rubro, f.account_id, a.code AS account_code, a.name AS account_name,
            f.difference_type, f.amount, f.description, f.created_at
     FROM "${schemaName()}"."fiscal_adjustments" f
     LEFT JOIN "${schemaName()}"."chart_of_accounts" a ON a.id = f.account_id
     WHERE f.tenant_id = :tenantId AND f.year = :year
     ORDER BY f.statement, f.created_at`,
    { replacements: { tenantId, year }, type: QueryTypes.SELECT }
  );
}

async function createAdjustment(tenantId, body, userId) {
  const year = checkYear(body.year);
  const statement = body.statement === 'eri' ? 'eri' : body.statement === 'esf' ? 'esf' : null;
  if (!statement) throw badRequest('Indica si el ajuste es patrimonial (esf) o de renta líquida (eri)');
  const type = body.difference_type === 'permanente' ? 'permanente' : 'temporaria';
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) throw badRequest('El valor del ajuste es obligatorio');
  const description = String(body.description || '').trim().slice(0, 300);
  if (!description) throw badRequest('Describe el ajuste (el contador debe poder sustentarlo)');

  let rubro = null;
  let accountId = null;
  if (statement === 'esf') {
    if (body.account_id) {
      if (!UUID_RE.test(String(body.account_id))) throw badRequest('Cuenta inválida');
      const accounts = await loadAccounts(tenantId);
      const acc = accounts.get(body.account_id);
      if (!acc || !['activo', 'pasivo'].includes(acc.account_type)) throw badRequest('El ajuste patrimonial va sobre una cuenta de activo o pasivo');
      accountId = acc.id;
      rubro = acc.rubro;
    } else {
      rubro = body.rubro;
      const r = RUBRO_BY_CODE[rubro];
      if (!r || r.statement !== 'esf' || r.section === 'patrimonio') throw badRequest('Elige un rubro de activo o pasivo, o una cuenta');
    }
  }
  const [[row]] = await sequelize.query(
    `INSERT INTO "${schemaName()}"."fiscal_adjustments" (tenant_id, year, statement, rubro, account_id, difference_type, amount, description, created_by)
     VALUES (:tenantId, :year, :statement, :rubro, :accountId, :type, :amount, :description, :userId) RETURNING id`,
    { replacements: { tenantId, year, statement, rubro, accountId, type, amount: round2(amount), description, userId: userId || null } }
  );
  return row;
}

async function deleteAdjustment(tenantId, id) {
  if (!UUID_RE.test(String(id))) throw badRequest('Ajuste inválido');
  await sequelize.query(
    `DELETE FROM "${schemaName()}"."fiscal_adjustments" WHERE tenant_id = :tenantId AND id = :id`,
    { replacements: { tenantId, id } }
  );
}

// Los ajustes patrimoniales temporarios son saldos al cierre: se copian del
// año anterior para revisarlos, en vez de volverlos a digitar.
async function copyAdjustmentsFromPreviousYear(tenantId, year, userId) {
  const y = checkYear(year);
  const [, count] = await sequelize.query(
    `INSERT INTO "${schemaName()}"."fiscal_adjustments" (tenant_id, year, statement, rubro, account_id, difference_type, amount, description, created_by)
     SELECT tenant_id, :year, statement, rubro, account_id, difference_type, amount, description, :userId
     FROM "${schemaName()}"."fiscal_adjustments"
     WHERE tenant_id = :tenantId AND year = :prev AND statement = 'esf' AND difference_type = 'temporaria'`,
    { replacements: { tenantId, year: y, prev: y - 1, userId: userId || null } }
  );
  return { copied: typeof count === 'number' ? count : count?.rowCount || 0 };
}

/* ═════════════════════════════ Ajustes automáticos ═════════════════════════════ */

async function mappedAccountId(tenantId, eventType) {
  const [row] = await sequelize.query(
    `SELECT account_id FROM "${schemaName()}"."account_mappings" WHERE tenant_id = :tenantId AND event_type = :eventType LIMIT 1`,
    { replacements: { tenantId, eventType }, type: QueryTypes.SELECT }
  );
  return row?.account_id || null;
}

// % de provisión fiscal por días vencidos.
function fiscalReceivablePct(method, daysOverdue) {
  if (method === 'general') {
    if (daysOverdue > 360) return 15;
    if (daysOverdue > 180) return 10;
    if (daysOverdue > 90) return 5;
    return 0;
  }
  if (method === 'individual') return daysOverdue > 360 ? 33 : 0;
  return 0;
}

async function fiscalReceivableAllowance(tenantId, cutoff, settings) {
  if (settings.receivable_method === 'none') return 0;
  const { fetchAging } = require('../../controllers/accounting/agingReport.controller');
  const aging = await fetchAging({ tenant_id: tenantId, query: { type: 'customer', as_of: cutoff } });
  let total = 0;
  for (const tp of aging.third_parties || []) {
    for (const c of tp.detail) total += c.amount * fiscalReceivablePct(settings.receivable_method, c.days_open - settings.credit_days) / 100;
  }
  return round2(total);
}

// Efecto acumulado de las mediciones de diferencia en cambio sobre cada
// partida (las reversiones llevan el mismo source_type y netean solas).
async function unrealizedFxByAccount(tenantId, cutoff) {
  const items = await sequelize.query(
    `SELECT l.account_id, l.third_party_id, COALESCE(SUM(l.debit - l.credit), 0) AS net_debit
     FROM "${schemaName()}"."journal_entry_lines" l
     JOIN "${schemaName()}"."journal_entries" e ON e.id = l.entry_id
     JOIN "${schemaName()}"."chart_of_accounts" a ON a.id = l.account_id
     WHERE e.tenant_id = :tenantId AND e.status = 'posted' AND e.source_type = 'niif_fx_remeasurement'
       AND e.entry_date <= :cutoff AND a.account_type IN ('activo', 'pasivo')
     GROUP BY l.account_id, l.third_party_id
     HAVING ABS(COALESCE(SUM(l.debit - l.credit), 0)) >= 0.01`,
    { replacements: { tenantId, cutoff }, type: QueryTypes.SELECT }
  );
  // Saldo de cada partida al corte (todas las líneas, no solo las de cambio):
  // en cero = ya se cobró o pagó = diferencia realizada.
  const out = [];
  for (const it of items) {
    const [bal] = await sequelize.query(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS balance
       FROM "${schemaName()}"."journal_entry_lines" l
       JOIN "${schemaName()}"."journal_entries" e ON e.id = l.entry_id
       WHERE e.tenant_id = :tenantId AND e.status = 'posted' AND e.entry_date <= :cutoff
         AND l.account_id = :accountId
         AND ${it.third_party_id ? 'l.third_party_id = :thirdPartyId' : 'TRUE'}`,
      { replacements: { tenantId, cutoff, accountId: it.account_id, thirdPartyId: it.third_party_id }, type: QueryTypes.SELECT }
    );
    out.push({ ...it, realized: Math.abs(Number(bal?.balance || 0)) < 1 });
  }
  return out;
}

const SECTION_GROUP = Object.fromEntries(NIIF_RUBROS.filter((r) => r.statement === 'esf').map((r) => [r.code, r.section.startsWith('activo') ? 'activo' : r.section.startsWith('pasivo') ? 'pasivo' : 'patrimonio']));

/* ═════════════════════════ Conciliación patrimonial ═════════════════════════ */

/**
 * @param {string} cutoff YYYY-MM-DD (31-dic para el 2516)
 * @returns {{ cutoff, year, settings, sections, adjustments, temporary, totals }}
 */
async function esfReconciliation(tenantId, cutoff) {
  if (!DATE_RE.test(String(cutoff))) throw badRequest('Fecha de corte inválida');
  const year = Number(cutoff.slice(0, 4));
  const [accounts, sums, settings, manual] = await Promise.all([
    loadAccounts(tenantId),
    sumsByAccount(tenantId, { to: cutoff }),
    getSettings(tenantId, year),
    listAdjustments(tenantId, year),
  ]);

  const natural = (a, s) => (s ? (a.account_type === 'activo' ? s.debit - s.credit : s.credit - s.debit) : 0);

  // Saldos contables por rubro / cuenta (solo activo y pasivo: el patrimonio
  // fiscal sale de restarlos).
  const rubros = new Map();
  const ensure = (code) => {
    if (!rubros.has(code)) rubros.set(code, { code, label: RUBRO_BY_CODE[code]?.label || code, group: SECTION_GROUP[code], accounts: [], adjustments: [] });
    return rubros.get(code);
  };
  for (const a of accounts.values()) {
    if (!['activo', 'pasivo'].includes(a.account_type)) continue;
    const bal = round2(natural(a, sums.get(a.id)));
    if (Math.abs(bal) < 0.005) continue;
    ensure(a.rubro).accounts.push({ id: a.id, code: a.code, name: a.name, book: bal });
  }

  const adjustments = [];
  const addAdj = (adj) => {
    if (Math.abs(adj.amount) < 0.01) return;
    adj.amount = round2(adj.amount);
    adj.group = SECTION_GROUP[adj.rubro];
    adjustments.push(adj);
    ensure(adj.rubro).adjustments.push(adj);
  };

  // 1. Propiedades, planta y equipo — libro fiscal de activos.
  const { fiscalReport } = require('./fixedAssetFiscal.service');
  const fa = await fiscalReport(tenantId, year);
  addAdj({
    key: 'auto:ppe', rubro: 'ppe', type: 'temporaria', source: 'auto',
    label: 'Activos fijos: valor fiscal (libro fiscal, art. 137 E.T.) − valor en libros', amount: Number(fa.totals?.temporary_difference || 0),
  });

  // 2. Cartera: provisión fiscal en lugar del deterioro NIIF.
  const allowId = await mappedAccountId(tenantId, 'receivable_impairment_allowance');
  const bookAllowance = allowId && accounts.get(allowId) ? -natural(accounts.get(allowId), sums.get(allowId)) : 0; // positivo
  const fiscalAllowance = await fiscalReceivableAllowance(tenantId, cutoff, settings);
  addAdj({
    key: 'auto:cartera', rubro: allowId ? accounts.get(allowId).rubro : 'deudores_comerciales', type: 'temporaria', source: 'auto',
    label: `Cartera: deterioro NIIF ${round2(bookAllowance)} reemplazado por provisión fiscal ${fiscalAllowance} (método ${settings.receivable_method})`,
    amount: bookAllowance - fiscalAllowance,
    detail: { book_allowance: round2(bookAllowance), fiscal_allowance: fiscalAllowance },
  });

  // 3. Inventarios: el deterioro por VNR no es deducible.
  const nrvId = await mappedAccountId(tenantId, 'inventory_nrv_allowance');
  if (nrvId && accounts.get(nrvId)) {
    const bookNrv = -natural(accounts.get(nrvId), sums.get(nrvId));
    addAdj({
      key: 'auto:vnr', rubro: accounts.get(nrvId).rubro, type: 'temporaria', source: 'auto',
      label: 'Inventarios: deterioro por valor neto realizable no deducible hasta la venta', amount: bookNrv,
    });
  }

  // 4. Provisiones: no deducibles hasta el pago (art. 105 E.T.).
  for (const a of accounts.values()) {
    if (a.account_type !== 'pasivo' || !['provisiones_corrientes', 'provisiones_no_corrientes'].includes(a.rubro)) continue;
    if (String(a.code).startsWith('2615')) continue; // obligaciones fiscales: pasivo fiscal real
    const bal = natural(a, sums.get(a.id));
    addAdj({
      key: `auto:prov:${a.id}`, rubro: a.rubro, account_id: a.id, type: 'temporaria', source: 'auto',
      label: `Provisión ${a.code} ${a.name}: sin valor fiscal hasta que se pague`, amount: -bal,
    });
  }

  // 5. Diferencia en cambio no realizada (las partidas ya saldadas se realizaron).
  for (const r of await unrealizedFxByAccount(tenantId, cutoff)) {
    const a = accounts.get(r.account_id);
    if (!a || r.realized) continue;
    const effect = a.account_type === 'activo' ? Number(r.net_debit) : -Number(r.net_debit);
    addAdj({
      key: `auto:fx:${a.id}:${r.third_party_id || ''}`, rubro: a.rubro, account_id: a.id, third_party_id: r.third_party_id || null,
      type: 'temporaria', source: 'auto',
      label: `Diferencia en cambio no realizada en ${a.code} ${a.name}${r.third_party_id ? ' (por tercero)' : ''}`, amount: -effect,
    });
  }

  // 6. Manuales.
  for (const m of manual.filter((x) => x.statement === 'esf')) {
    addAdj({
      key: `manual:${m.id}`, id: m.id, rubro: m.rubro, account_id: m.account_id, type: m.difference_type, source: 'manual',
      label: m.description, amount: Number(m.amount),
    });
  }

  const order = new Map(NIIF_RUBROS.map((r, i) => [r.code, i]));
  const rubroRows = [...rubros.values()]
    .filter((r) => r.group === 'activo' || r.group === 'pasivo')
    .sort((a, b) => order.get(a.code) - order.get(b.code))
    .map((r) => {
      const book = round2(r.accounts.reduce((s, x) => s + x.book, 0));
      const adj = round2(r.adjustments.reduce((s, x) => s + x.amount, 0));
      return { ...r, book, adjustment: adj, fiscal: round2(book + adj) };
    });

  const tot = (group, k) => round2(rubroRows.filter((r) => r.group === group).reduce((s, r) => s + r[k], 0));
  const totals = {};
  for (const k of ['book', 'adjustment', 'fiscal']) {
    totals[k] = { activo: tot('activo', k), pasivo: tot('pasivo', k) };
    totals[k].patrimonio = round2(totals[k].activo - totals[k].pasivo);
  }

  return {
    cutoff, year, settings,
    rubros: rubroRows,
    adjustments,
    temporary: adjustments.filter((a) => a.type === 'temporaria'),
    totals,
  };
}

/* ═════════════════════════ Conciliación de renta líquida ═════════════════════════ */

async function eriReconciliation(tenantId, year) {
  const y = checkYear(year);
  const [eri, end, start, manual, settings] = await Promise.all([
    comprehensiveIncome(tenantId, { from: `${y}-01-01`, to: `${y}-12-31` }),
    esfReconciliation(tenantId, `${y}-12-31`),
    esfReconciliation(tenantId, `${y - 1}-12-31`),
    listAdjustments(tenantId, y),
    getSettings(tenantId, y),
  ]);

  // Variación de cada diferencia temporaria en el año. Activo: si el valor
  // fiscal quedó por encima del contable, la contabilidad llevó a resultados
  // algo que fiscalmente aún no se deduce → suma a la renta. Pasivo: al revés.
  const byKey = new Map();
  for (const a of start.temporary) byKey.set(a.key, { key: a.key, label: a.label, group: a.group, start: a.amount, end: 0 });
  for (const a of end.temporary) {
    const row = byKey.get(a.key) || { key: a.key, label: a.label, group: a.group, start: 0 };
    row.end = a.amount;
    row.label = a.label;
    row.group = a.group;
    byKey.set(a.key, row);
  }
  const temporary = [...byKey.values()].map((r) => {
    const delta = round2(r.end - r.start);
    return { ...r, delta, effect: r.group === 'pasivo' ? -delta : delta };
  }).filter((r) => Math.abs(r.effect) >= 0.01);

  const permanent = manual.filter((m) => m.statement === 'eri').map((m) => ({
    id: m.id, label: m.description, type: m.difference_type, effect: round2(Number(m.amount)),
  }));

  const before = eri.totals.current.resultado_antes_impuestos;
  const tempTotal = round2(temporary.reduce((s, r) => s + r.effect, 0));
  const permTotal = round2(permanent.reduce((s, r) => s + r.effect, 0));
  const rentaLiquida = round2(before + tempTotal + permTotal);
  const compensation = round2(Math.min(settings.tax_losses, Math.max(0, rentaLiquida)));
  const gravable = round2(Math.max(0, rentaLiquida - compensation));

  return {
    year: y, settings,
    resultado_antes_impuestos: before,
    impuesto_contabilizado: eri.totals.current.impuesto_ganancias,
    temporary, permanent,
    totals: {
      temporary: tempTotal, permanent: permTotal,
      renta_liquida: rentaLiquida,
      perdida_fiscal: rentaLiquida < 0 ? round2(-rentaLiquida) : 0,
      compensacion_perdidas: compensation,
      renta_liquida_gravable: gravable,
      impuesto_estimado: round2(gravable * settings.tax_rate / 100),
    },
  };
}

/* ═════════════════════════════ Impuesto diferido ═════════════════════════════ */

async function deferredTax(tenantId, cutoff) {
  const profile = await tenantProfile(tenantId);
  if (profile.is_simple) throw badRequest('La empresa está en el Régimen Simple: no liquida impuesto de renta, así que no hay impuesto diferido.');
  if (profile.niif_group === '3') throw badRequest('Las microempresas (Grupo 3) no reconocen impuesto diferido.');

  const esf = await esfReconciliation(tenantId, cutoff);
  const { settings } = esf;
  const rate = settings.tax_rate / 100;

  // Diferencia deducible (+) o imponible (−) de cada partida.
  const items = esf.temporary.map((a) => {
    const deductible = round2(a.group === 'pasivo' ? -a.amount : a.amount);
    return { key: a.key, label: a.label, rubro: a.rubro, group: a.group, difference: a.amount, deductible, tax: round2(deductible * rate) };
  });
  if (settings.tax_losses > 0) {
    items.push({ key: 'losses', label: 'Pérdidas fiscales por compensar', rubro: null, group: null, difference: settings.tax_losses, deductible: settings.tax_losses, tax: round2(settings.tax_losses * rate) });
  }

  const dtaGross = round2(items.filter((i) => i.deductible > 0).reduce((s, i) => s + i.tax, 0));
  const dtl = round2(-items.filter((i) => i.deductible < 0).reduce((s, i) => s + i.tax, 0));
  // Sin certeza de renta futura, el activo diferido solo se reconoce hasta
  // el pasivo diferido que se va a revertir (sección 29.21).
  const dta = settings.recognize_dta ? dtaGross : Math.min(dtaGross, dtl);

  return { esf, settings, items, dta_gross: dtaGross, dta: round2(dta), dtl };
}

module.exports = {
  DEFAULT_SETTINGS, normalizeSettings, getSettings, saveSettings,
  listAdjustments, createAdjustment, deleteAdjustment, copyAdjustmentsFromPreviousYear,
  esfReconciliation, eriReconciliation, deferredTax, fiscalReceivablePct, tenantProfile,
};
