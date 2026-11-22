// backend/src/services/accounting/niifNotes.service.js
//
// Notas a los estados financieros (NIIF para Pymes, sección 8). Se arman
// solas con lo que Pitbox sabe de la empresa: entidad, bases de
// preparación, políticas contables según la configuración real (costeo,
// métodos de depreciación, matriz de deterioro, tarifa de renta) y una nota
// por cada rubro con saldo, con su detalle (cartera por edades, activos
// fijos por categoría, créditos, impuesto diferido...).
//
// El contador puede agregar texto a cualquier nota o reemplazar el
// automático (niif_report_texts, por año). Las cifras salen siempre de los
// libros: lo editable es la redacción.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { RUBRO_BY_CODE, niifGroupOf } = require('../../data/niifRubros');
const statements = require('./niifStatements.service');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const schemaName = () => getCurrentSchema() || 'public';
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const fmtMoney = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n || 0));

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const NOTE_KEY_RE = /^[a-z0-9_]{1,60}$/;

const METHOD_LABELS = {
  linea_recta: 'línea recta',
  saldos_decrecientes: 'saldos decrecientes',
  unidades_produccion: 'unidades de producción',
  menor_cuantia: 'depreciación total en el año (activos de menor cuantía)',
  no_deprecia: 'sin depreciación (terrenos)',
};
const CATEGORY_LABELS = {
  vehiculo: 'Flota y equipo de transporte', maquinaria: 'Maquinaria y equipo', equipo_computo: 'Equipo de cómputo',
  equipo_comunicacion: 'Equipo de comunicación', muebles_enseres: 'Muebles y enseres', construcciones: 'Construcciones y edificaciones',
  terrenos: 'Terrenos', otro: 'Otros',
};

/* ─────────────────────────── Textos del contador ─────────────────────────── */

async function loadTexts(tenantId, year) {
  const rows = await sequelize.query(
    `SELECT note_key, mode, body FROM "${schemaName()}"."niif_report_texts" WHERE tenant_id = :tenantId AND year = :year`,
    { replacements: { tenantId, year }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.note_key, r]));
}

async function saveText(tenantId, year, noteKey, { mode, body } = {}, userId) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Año inválido');
  if (!NOTE_KEY_RE.test(String(noteKey || ''))) throw badRequest('Nota inválida');
  const text = String(body ?? '').slice(0, 20000);
  if (!text.trim()) {
    await sequelize.query(
      `DELETE FROM "${schemaName()}"."niif_report_texts" WHERE tenant_id = :tenantId AND year = :year AND note_key = :noteKey`,
      { replacements: { tenantId, year: y, noteKey } }
    );
    return null;
  }
  await sequelize.query(
    `INSERT INTO "${schemaName()}"."niif_report_texts" (tenant_id, year, note_key, mode, body, updated_by)
     VALUES (:tenantId, :year, :noteKey, :mode, :body, :userId)
     ON CONFLICT (tenant_id, year, note_key) DO UPDATE SET mode = EXCLUDED.mode, body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    { replacements: { tenantId, year: y, noteKey, mode: mode === 'replace' ? 'replace' : 'append', body: text, userId: userId || null } }
  );
  return { mode: mode === 'replace' ? 'replace' : 'append', body: text };
}

// Firmas (art. 37 Ley 222 de 1995): representante legal, contador y, si
// hay, revisor fiscal.
const SIGNATURE_FIELDS = ['legal_rep_name', 'legal_rep_id', 'accountant_name', 'accountant_tp', 'auditor_name', 'auditor_tp'];

function parseSignatures(row) {
  try {
    const obj = row ? JSON.parse(row.body) : {};
    return Object.fromEntries(SIGNATURE_FIELDS.map((k) => [k, String(obj[k] || '').slice(0, 120)]));
  } catch {
    return Object.fromEntries(SIGNATURE_FIELDS.map((k) => [k, '']));
  }
}

async function saveSignatures(tenantId, year, raw, userId) {
  const clean = Object.fromEntries(SIGNATURE_FIELDS.map((k) => [k, String(raw?.[k] || '').trim().slice(0, 120)]));
  await saveText(tenantId, year, '_firmas', { mode: 'append', body: JSON.stringify(clean) }, userId);
  return clean;
}

/* ─────────────────────────── Datos de apoyo ─────────────────────────── */

async function q(sql, replacements) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

async function mappedAccountId(tenantId, eventType) {
  const [row] = await q(
    `SELECT account_id FROM "${schemaName()}"."account_mappings" WHERE tenant_id = :tenantId AND event_type = :eventType LIMIT 1`,
    { tenantId, eventType }
  );
  return row?.account_id || null;
}

// Saldo (negativo, cuenta correctora) de la provisión mapeada dentro del rubro.
function allowanceIn(rubro, accountId) {
  const acc = accountId ? rubro.accounts.find((a) => a.id === accountId) : null;
  return acc ? acc.current : 0;
}

async function lastMeasurementParams(tenantId, kind, asOf) {
  const [row] = await q(
    `SELECT params, cutoff_date FROM "${schemaName()}"."niif_measurements"
     WHERE tenant_id = :tenantId AND kind = :kind AND status = 'posted' AND cutoff_date <= :asOf
     ORDER BY cutoff_date DESC, created_at DESC LIMIT 1`,
    { tenantId, kind, asOf }
  );
  return row || null;
}

async function loansAt(tenantId, asOf) {
  const loans = await q(
    `SELECT l.id, l.lender_name, l.loan_type, l.principal_amount, l.annual_interest_rate, l.term_months, l.disbursement_date, l.status
     FROM "${schemaName()}"."loans" l
     WHERE l.tenant_id = :tenantId AND l.disbursement_date <= :asOf AND l.status <> 'cancelado'`,
    { tenantId, asOf }
  );
  const out = [];
  for (const l of loans) {
    const [paid] = await q(
      `SELECT MIN(balance_after) AS bal FROM "${schemaName()}"."loan_installments"
       WHERE loan_id = :id AND status = 'pagada' AND paid_date <= :asOf`,
      { id: l.id, asOf }
    );
    const balance = paid?.bal !== null && paid?.bal !== undefined ? Number(paid.bal) : Number(l.principal_amount);
    if (balance <= 0.5) continue;
    // Porción corriente: capital de las cuotas pendientes que vencen en los 12 meses siguientes.
    const [cur] = await q(
      `SELECT COALESCE(SUM(principal_amount), 0) AS amt FROM "${schemaName()}"."loan_installments"
       WHERE loan_id = :id AND due_date > :asOf AND due_date <= (:asOf::date + INTERVAL '12 months')
         AND NOT (status = 'pagada' AND paid_date <= :asOf)`,
      { id: l.id, asOf }
    );
    const current = Math.min(balance, Number(cur.amt));
    out.push({ ...l, balance: round2(balance), current: round2(current), non_current: round2(balance - current) });
  }
  return out;
}

/* ─────────────────────────── Construcción ─────────────────────────── */

function accountsTable(accounts, labels) {
  return {
    columns: [{ label: 'Cuenta' }, { label: 'Concepto' }, { label: labels[0], align: 'right' }, { label: labels[1], align: 'right' }],
    rows: accounts.map((a) => [a.code || '', a.name, a.current, a.prior]),
    money_from: 2,
    total: ['', 'Total', round2(accounts.reduce((s, a) => s + a.current, 0)), round2(accounts.reduce((s, a) => s + a.prior, 0))],
  };
}

/**
 * @param {{ as_of, compare_as_of?, from? }} opts — from: inicio del periodo del
 *   resultado (por defecto 1-ene del año del corte).
 */
async function buildNotes(tenantId, opts = {}) {
  const asOf = opts.as_of && DATE_RE.test(opts.as_of) ? opts.as_of : new Date().toISOString().slice(0, 10);
  const year = Number(asOf.slice(0, 4));
  const from = opts.from && DATE_RE.test(opts.from) ? opts.from : `${year}-01-01`;
  const compareAsOf = opts.compare_as_of && DATE_RE.test(opts.compare_as_of) ? opts.compare_as_of : `${year - 1}-12-31`;

  const [tenantRow] = await q(`SELECT company_name, business_name, tax_id, address, email, phone, business_config, tax_config FROM "public"."tenants" WHERE id = :tenantId`, { tenantId });
  const [esf, eri, texts] = await Promise.all([
    statements.financialPosition(tenantId, { as_of: asOf, compare_as_of: compareAsOf }),
    statements.comprehensiveIncome(tenantId, { from, to: asOf }),
    loadTexts(tenantId, year),
  ]);
  const isSimple = tenantRow?.tax_config?.fiscal_profile?.regime === 'simple';
  const group = niifGroupOf(tenantRow || {});
  const esfLabels = [fmtDate(asOf), fmtDate(compareAsOf)];
  const eriLabels = [`${fmtDate(from)} – ${fmtDate(asOf)}`, `${fmtDate(eri.compare_from)} – ${fmtDate(eri.compare_to)}`];

  const notes = [];
  const add = (note) => {
    const custom = texts.get(note.key);
    notes.push({ ...note, number: notes.length + 1, custom: custom ? { mode: custom.mode, body: custom.body } : null });
  };

  // 1. Entidad
  const name = tenantRow?.business_name || tenantRow?.company_name || 'La entidad';
  add({
    key: 'entidad',
    title: 'Entidad que informa',
    paragraphs: [
      `${name}${tenantRow?.tax_id ? `, identificada con NIT ${tenantRow.tax_id}` : ''}${tenantRow?.address ? `, con domicilio en ${tenantRow.address}` : ''}.`,
      'Describa aquí la naturaleza jurídica, el objeto social y las actividades principales de la entidad.',
    ],
  });

  // 2. Bases de preparación
  add({
    key: 'bases',
    title: 'Bases de preparación',
    paragraphs: [
      `Los estados financieros se prepararon de acuerdo con la Norma Internacional de Información Financiera para Pequeñas y Medianas Entidades (NIIF para las Pymes), incorporada en Colombia como ${group === '3' ? 'marco de las microempresas (Grupo 3)' : 'Grupo 2'} por el Decreto Único Reglamentario 2420 de 2015 y sus modificaciones.`,
      `Comprenden el estado de situación financiera al ${fmtDate(asOf)}, comparado con el ${fmtDate(compareAsOf)}, y los estados del resultado integral, de cambios en el patrimonio y de flujos de efectivo del periodo ${fmtDate(from)} – ${fmtDate(asOf)}.`,
      'La moneda funcional y de presentación es el peso colombiano (COP). Las cifras se presentan en pesos. Los estados se prepararon sobre la base del costo histórico, salvo las partidas que la norma exige medir de otra forma, y bajo la hipótesis de negocio en marcha.',
    ],
  });

  // 3. Políticas contables
  const assets = await q(
    `SELECT DISTINCT depreciation_method FROM "${schemaName()}"."fixed_assets" WHERE tenant_id = :tenantId AND acquisition_date <= :asOf`,
    { tenantId, asOf }
  );
  const methods = assets.map((a) => METHOD_LABELS[a.depreciation_method] || a.depreciation_method);
  const impairment = await lastMeasurementParams(tenantId, 'receivable_impairment', asOf);
  const matrix = Array.isArray(impairment?.params?.matrix) ? impairment.params.matrix : null;
  const nrv = await lastMeasurementParams(tenantId, 'inventory_nrv', asOf);
  let taxRate = 35;
  try {
    const [s] = await q(`SELECT settings FROM "${schemaName()}"."fiscal_reconciliation_settings" WHERE tenant_id = :tenantId AND year = :year`, { tenantId, year });
    if (s?.settings?.tax_rate !== undefined) taxRate = Number(s.settings.tax_rate);
  } catch { /* sin conciliación aún */ }

  add({
    key: 'politicas',
    title: 'Políticas contables significativas',
    paragraphs: [
      '**Efectivo y equivalentes.** Incluye caja, depósitos en bancos y cuentas de ahorro de libre disponibilidad.',
      `**Cuentas por cobrar.** Son instrumentos financieros básicos (sección 11) medidos al valor de la transacción, pues se otorgan en plazos normales de crédito sin financiación. Al cierre se evalúa la evidencia objetiva de deterioro${matrix ? ` con una matriz por antigüedad: ${matrix.map((r) => `${r.pct}% desde ${r.from_days} días`).join(', ')}, además del análisis individual de clientes en dificultades` : ''}.`,
      `**Inventarios.** Se miden al menor entre el costo y el valor neto realizable (sección 13). El costo se determina por el método de promedio ponderado.${nrv ? ` El valor neto realizable es el precio estimado de venta sin IVA menos ${Number(nrv.params?.selling_cost_pct || 0)}% de gastos de venta.` : ''}`,
      `**Propiedades, planta y equipo.** Se miden al costo menos la depreciación acumulada y las pérdidas por deterioro (sección 17).${methods.length ? ` Métodos de depreciación usados: ${methods.join(', ')}.` : ''} La depreciación se reconoce desde el mes siguiente al de la adquisición, a lo largo de la vida útil estimada de cada activo y hasta su valor residual.`,
      '**Pasivos financieros.** Las obligaciones financieras y cuentas por pagar se miden al costo amortizado; los intereses se reconocen como costo financiero en el periodo en que se causan.',
      '**Ingresos.** Los ingresos por venta de bienes se reconocen cuando se transfieren al cliente los riesgos y ventajas, y los de servicios a medida que se prestan (sección 23). Los cobros anticipados se reconocen como pasivo hasta que se cumple la obligación; los ingresos recibidos por periodos futuros se difieren y se amortizan mes a mes.',
      '**Beneficios a los empleados.** Los beneficios de corto plazo (salarios, prestaciones sociales, aportes) se reconocen como gasto y pasivo a medida que el empleado presta el servicio (sección 28).',
      '**Transacciones en moneda extranjera.** Se registran a la tasa de cambio de la fecha de la transacción; al cierre, las partidas monetarias se reexpresan a la tasa representativa del mercado y la diferencia se reconoce en resultados (sección 30).',
      isSimple
        ? '**Impuestos.** La entidad tributa en el Régimen Simple de Tributación, que sustituye el impuesto de renta; por ello no reconoce impuesto de renta diferido.'
        : `**Impuesto a las ganancias.** Comprende el impuesto corriente y el diferido (sección 29). El diferido se reconoce sobre las diferencias temporarias entre el valor contable y el fiscal de activos y pasivos, a la tarifa de ${taxRate}%.`,
    ],
  });

  // 4+. Una nota por rubro con saldo.
  const esfNotes = [];
  for (const sec of esf.sections) {
    for (const r of sec.rubros) {
      if (Math.abs(r.current) < 0.5 && Math.abs(r.prior) < 0.5) continue;
      esfNotes.push({ rubro: r, section: sec });
    }
  }
  const ref = {}; // rubro → número de nota (para el estado de situación financiera)

  for (const { rubro: r, section } of esfNotes) {
    const note = { key: `rubro_${r.code}`, rubro: r.code, title: r.label, paragraphs: [], tables: [accountsTable(r.accounts, esfLabels)] };

    if (r.code === 'efectivo') {
      const banks = await q(
        `SELECT bank_name, account_type, currency, account_alias, account_number FROM "${schemaName()}"."bank_accounts" WHERE tenant_id = :tenantId AND is_active = true ORDER BY bank_name`,
        { tenantId }
      );
      if (banks.length) note.paragraphs.push(`La entidad tiene ${banks.length} cuenta(s) bancaria(s): ${banks.map((b) => `${b.bank_name} (${b.account_type}${b.currency !== 'COP' ? `, ${b.currency}` : ''})`).join('; ')}.`);
    }

    if (r.code === 'deudores_comerciales') {
      try {
        const { fetchAging } = require('../../controllers/accounting/agingReport.controller');
        const aging = await fetchAging({ tenant_id: tenantId, query: { type: 'customer', as_of: asOf } });
        if (!aging.warning && aging.grand_total > 0) {
          note.tables.push({
            title: 'Cartera de clientes por antigüedad (días desde la factura)',
            columns: [{ label: 'Tramo' }, { label: 'Saldo', align: 'right' }, { label: '%', align: 'right' }],
            rows: aging.buckets.filter((b) => b.total > 0.5).map((b) => [b.label, round2(b.total), `${(b.total / aging.grand_total * 100).toFixed(1)}%`]),
            money_from: 1, money_to: 1,
            total: ['Total cartera', round2(aging.grand_total), '100%'],
          });
        }
      } catch { /* sin mapeo de cartera */ }
      const allowance = allowanceIn(r, await mappedAccountId(tenantId, 'receivable_impairment_allowance'));
      if (allowance < 0) note.paragraphs.push(`El deterioro acumulado de cartera al corte es de ${fmtMoney(-allowance)}${impairment ? `, según la medición al ${fmtDate(impairment.cutoff_date)}` : ''}.`);
    }

    if (r.code === 'inventarios') {
      note.paragraphs.push('Los inventarios se valoran a costo promedio ponderado.');
      const allowance = allowanceIn(r, await mappedAccountId(tenantId, 'inventory_nrv_allowance'));
      if (allowance < 0) note.paragraphs.push(`Se reconoció un deterioro por valor neto realizable de ${fmtMoney(-allowance)}${nrv ? ` (medición al ${fmtDate(nrv.cutoff_date)})` : ''}.`);
    }

    if (r.code === 'ppe') {
      try {
        const { fiscalReport } = require('./fixedAssetFiscal.service');
        const fa = await fiscalReport(tenantId, year);
        const byCat = new Map();
        for (const a of fa.rows || []) {
          if (a.disposed) continue;
          const c = byCat.get(a.category) || { cost: 0, dep: 0, imp: 0, net: 0 };
          c.cost += a.cost; c.dep += a.accounting_accumulated; c.imp += a.impaired; c.net += a.book_accounting;
          byCat.set(a.category, c);
        }
        if (byCat.size) {
          const rows = [...byCat.entries()].map(([k, c]) => [CATEGORY_LABELS[k] || k, round2(c.cost), round2(-c.dep), round2(-c.imp), round2(c.net)]);
          const sum = (i) => round2(rows.reduce((s, x) => s + x[i], 0));
          note.tables.push({
            title: `Activos fijos por categoría al 31/12/${year} (módulo de activos fijos)`,
            columns: [{ label: 'Categoría' }, { label: 'Costo', align: 'right' }, { label: 'Depreciación acumulada', align: 'right' }, { label: 'Deterioro', align: 'right' }, { label: 'Valor en libros', align: 'right' }],
            rows, money_from: 1,
            total: ['Total', sum(1), sum(2), sum(3), sum(4)],
          });
        }
      } catch { /* sin activos */ }
    }

    if (r.code.startsWith('obligaciones_financieras')) {
      const loans = await loansAt(tenantId, asOf);
      if (loans.length) {
        note.tables.push({
          title: 'Créditos vigentes',
          columns: [{ label: 'Acreedor' }, { label: 'Tasa anual', align: 'right' }, { label: 'Plazo', align: 'right' }, { label: 'Saldo', align: 'right' }, { label: 'Corriente (12 meses)', align: 'right' }, { label: 'No corriente', align: 'right' }],
          rows: loans.map((l) => [l.lender_name, `${Number(l.annual_interest_rate)}%`, `${l.term_months} meses`, l.balance, l.current, l.non_current]),
          money_from: 3,
          total: ['Total', '', '', round2(loans.reduce((s, l) => s + l.balance, 0)), round2(loans.reduce((s, l) => s + l.current, 0)), round2(loans.reduce((s, l) => s + l.non_current, 0))],
        });
        note.paragraphs.push('La porción corriente es el capital de las cuotas que vencen en los doce meses siguientes al corte; el resto se presenta como no corriente (para separarlo, fije el rubro de la cuenta en el Plan de Cuentas).');
      }
    }

    if (r.code === 'activo_impuesto_diferido' || r.code === 'pasivo_impuesto_diferido') {
      try {
        const { deferredTax } = require('./fiscalReconciliation.service');
        const dt = await deferredTax(tenantId, asOf);
        if (dt.items.length) {
          note.tables.push({
            title: `Diferencias temporarias al corte (tarifa ${dt.settings.tax_rate}%)`,
            columns: [{ label: 'Partida' }, { label: 'Deducible (+) / imponible (−)', align: 'right' }, { label: 'Impuesto diferido', align: 'right' }],
            rows: dt.items.map((i) => [i.label, i.deductible, i.tax]),
            money_from: 1,
          });
        }
      } catch { /* régimen simple o sin conciliación */ }
    }

    if (section.group === 'patrimonio' && r.code === 'resultado_ejercicio') {
      note.paragraphs.push('Incluye el resultado del ejercicio aún no trasladado a ganancias acumuladas. Los movimientos del patrimonio se presentan en el estado de cambios en el patrimonio.');
    }

    ref[r.code] = notes.length + 1;
    add(note);
  }

  // Resultado: una nota por línea con rubro y saldo.
  for (const line of eri.lines) {
    if (!line.rubro || (Math.abs(line.current) < 0.5 && Math.abs(line.prior) < 0.5)) continue;
    // Montos positivos en el sentido del rubro (ingreso como ingreso, gasto como gasto).
    const accounts = line.accounts || [];
    const note = { key: `rubro_${line.rubro}`, rubro: line.rubro, title: RUBRO_BY_CODE[line.rubro]?.label || line.label, paragraphs: [], tables: [accountsTable(accounts, eriLabels)] };
    if (line.rubro === 'impuesto_ganancias' && isSimple) note.paragraphs.push('La entidad tributa en el Régimen Simple de Tributación.');
    ref[line.rubro] = notes.length + 1;
    add(note);
  }

  add({
    key: 'hechos_posteriores',
    title: 'Hechos ocurridos después del periodo sobre el que se informa',
    paragraphs: ['Entre la fecha de corte y la de aprobación de los estados financieros no se conocieron hechos que requieran ajustes o revelaciones adicionales.'],
  });
  add({
    key: 'aprobacion',
    title: 'Aprobación de los estados financieros',
    paragraphs: ['Los estados financieros fueron autorizados para su publicación por el representante legal. Indique aquí la fecha y el órgano que los aprobó (junta de socios o asamblea de accionistas).'],
  });

  return {
    as_of: asOf, compare_as_of: compareAsOf, from, year,
    tenant: { name, tax_id: tenantRow?.tax_id || '', address: tenantRow?.address || '' },
    signatures: parseSignatures(texts.get('_firmas')),
    notes,
    rubro_note_numbers: ref,
  };
}

module.exports = { buildNotes, saveText, saveSignatures, SIGNATURE_FIELDS };
