// backend/src/services/accounting/niifStatements.service.js
//
// Estados financieros NIIF para Pymes (Grupo 2) a partir del único libro
// contable. Cada cuenta se presenta bajo su rubro (data/niifRubros.js).
//
//   - Estado de situación financiera (sección 4): corriente / no corriente,
//     comparativo contra otra fecha de corte (por defecto el 31-dic anterior).
//   - Estado del resultado integral (sección 5): por función, resultado del
//     periodo + otro resultado integral, comparativo contra el mismo rango
//     del año anterior.
//   - Estado de cambios en el patrimonio (sección 6).
//
// Solo cuentan asientos 'posted'. El asiento de cierre anual
// (source_type = 'year_end_close') se excluye de los rangos de resultado:
// salda ingresos/gastos contra 3605 el 31-dic, y si se incluyera el
// resultado de un año cerrado saldría en cero.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const { NIIF_RUBROS, RUBRO_BY_CODE, resolveRubros } = require('../../data/niifRubros');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function checkDate(value, name) {
  if (!value || !DATE_RE.test(String(value))) throw badRequest(`${name} es obligatorio (YYYY-MM-DD)`);
  return String(value);
}

function checkBranch(branchId) {
  if (!branchId) return null;
  if (!UUID_RE.test(String(branchId))) throw badRequest('branch_id inválido');
  return String(branchId);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function minusOneYear(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  // 29-feb -> 28-feb del año anterior.
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Plan de cuentas con su rubro efectivo. */
async function loadAccounts(tenantId) {
  const schema = getCurrentSchema() || 'public';
  const accounts = await sequelize.query(
    `SELECT id, code, name, account_type, parent_id, niif_rubro
     FROM "${schema}"."chart_of_accounts" WHERE tenant_id = :tenantId ORDER BY code`,
    { replacements: { tenantId }, type: QueryTypes.SELECT }
  );
  const rubros = resolveRubros(accounts);
  const byId = new Map();
  for (const a of accounts) {
    const r = rubros.get(a.id);
    byId.set(a.id, { ...a, rubro: r.rubro, rubro_source: r.source });
  }
  return byId;
}

/**
 * Débitos/créditos por cuenta.
 * @param {object} o { from?, to, branchId, close: 'include'|'exclude'|'only' }
 * @returns {Map<accountId, {debit, credit}>}
 */
async function sumsByAccount(tenantId, { from = null, to, branchId = null, close = 'include' }) {
  const schema = getCurrentSchema() || 'public';
  const closeSql = close === 'exclude' ? `AND e.source_type <> 'year_end_close'`
    : close === 'only' ? `AND e.source_type = 'year_end_close'` : '';
  const rows = await sequelize.query(
    `SELECT l.account_id, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
     FROM "${schema}"."journal_entry_lines" l
     JOIN "${schema}"."journal_entries" e ON e.id = l.entry_id
     WHERE e.tenant_id = :tenantId AND e.status = 'posted'
       AND (:from::date IS NULL OR e.entry_date >= :from::date)
       AND e.entry_date <= :to::date
       AND (:branchId::uuid IS NULL OR e.branch_id = :branchId::uuid)
       ${closeSql}
     GROUP BY l.account_id`,
    { replacements: { tenantId, from, to, branchId }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.account_id, { debit: Number(r.debit), credit: Number(r.credit) }]));
}

// Saldo con el signo natural de la cuenta.
function naturalBalance(account, s) {
  if (!s) return 0;
  return ['activo', 'gasto', 'costo'].includes(account.account_type) ? s.debit - s.credit : s.credit - s.debit;
}

const isPnl = (a) => ['ingreso', 'gasto', 'costo'].includes(a.account_type);
const rubroOrder = new Map(NIIF_RUBROS.map((r, i) => [r.code, i]));

/* ══════════════════════ Estado de situación financiera ══════════════════════ */

const ESF_SECTIONS = [
  { code: 'activo_corriente', label: 'Activo corriente', group: 'activo' },
  { code: 'activo_no_corriente', label: 'Activo no corriente', group: 'activo' },
  { code: 'pasivo_corriente', label: 'Pasivo corriente', group: 'pasivo' },
  { code: 'pasivo_no_corriente', label: 'Pasivo no corriente', group: 'pasivo' },
  { code: 'patrimonio', label: 'Patrimonio', group: 'patrimonio' },
];

async function financialPosition(tenantId, { as_of, compare_as_of, branch_id } = {}) {
  const asOf = checkDate(as_of || new Date().toISOString().slice(0, 10), 'as_of');
  const compareAsOf = compare_as_of ? checkDate(compare_as_of, 'compare_as_of') : `${Number(asOf.slice(0, 4)) - 1}-12-31`;
  const branchId = checkBranch(branch_id);

  const [accounts, cur, prev] = await Promise.all([
    loadAccounts(tenantId),
    sumsByAccount(tenantId, { to: asOf, branchId }),
    sumsByAccount(tenantId, { to: compareAsOf, branchId }),
  ]);

  const rubroMap = new Map(); // rubro -> { accounts: [] }
  let unclosedCur = 0;
  let unclosedPrev = 0;
  const unclassified = [];

  for (const a of accounts.values()) {
    const c = naturalBalance(a, cur.get(a.id));
    const p = naturalBalance(a, prev.get(a.id));
    if (Math.abs(c) < 0.005 && Math.abs(p) < 0.005) continue;
    if (isPnl(a)) {
      // Resultado aún no trasladado a patrimonio (no hubo cierre anual).
      const sign = a.account_type === 'ingreso' ? 1 : -1;
      unclosedCur += sign * c;
      unclosedPrev += sign * p;
      continue;
    }
    if (a.rubro_source === 'sin_clasificar') unclassified.push({ id: a.id, code: a.code, name: a.name });
    if (!rubroMap.has(a.rubro)) rubroMap.set(a.rubro, []);
    rubroMap.get(a.rubro).push({ id: a.id, code: a.code, name: a.name, current: round2(c), prior: round2(p) });
  }
  if (Math.abs(unclosedCur) >= 0.005 || Math.abs(unclosedPrev) >= 0.005) {
    if (!rubroMap.has('resultado_ejercicio')) rubroMap.set('resultado_ejercicio', []);
    rubroMap.get('resultado_ejercicio').push({
      id: null, code: '', name: 'Resultado del ejercicio en curso (sin cierre anual)',
      current: round2(unclosedCur), prior: round2(unclosedPrev),
    });
  }

  const sections = ESF_SECTIONS.map((sec) => {
    const rubros = NIIF_RUBROS.filter((r) => r.statement === 'esf' && r.section === sec.code && rubroMap.has(r.code))
      .map((r) => {
        const accs = rubroMap.get(r.code);
        return {
          code: r.code, label: r.label, accounts: accs,
          current: round2(accs.reduce((s, x) => s + x.current, 0)),
          prior: round2(accs.reduce((s, x) => s + x.prior, 0)),
        };
      });
    return {
      code: sec.code, label: sec.label, group: sec.group, rubros,
      current: round2(rubros.reduce((s, r) => s + r.current, 0)),
      prior: round2(rubros.reduce((s, r) => s + r.prior, 0)),
    };
  });

  const total = (group, key) => round2(sections.filter((s) => s.group === group).reduce((acc, s) => acc + s[key], 0));
  const totals = {};
  for (const key of ['current', 'prior']) {
    const activo = total('activo', key);
    const pasivo = total('pasivo', key);
    const patrimonio = total('patrimonio', key);
    totals[key] = { activo, pasivo, patrimonio, pasivo_patrimonio: round2(pasivo + patrimonio), cuadra: Math.abs(activo - pasivo - patrimonio) < 0.01 };
  }

  return { as_of: asOf, compare_as_of: compareAsOf, branch_id: branchId, sections, totals, unclassified };
}

/* ═════════════════════ Estado del resultado integral ═════════════════════ */

function pnlAmount(a, s) {
  if (!s) return 0;
  return a.account_type === 'ingreso' ? s.credit - s.debit : s.debit - s.credit;
}

function buildIncome(accounts, sums, oriSums) {
  const byRubro = new Map();
  for (const a of accounts.values()) {
    if (!isPnl(a)) continue;
    const amt = pnlAmount(a, sums.get(a.id));
    if (Math.abs(amt) < 0.005) continue;
    if (!byRubro.has(a.rubro)) byRubro.set(a.rubro, []);
    byRubro.get(a.rubro).push({ id: a.id, code: a.code, name: a.name, amount: round2(amt) });
  }
  const sum = (rubro) => round2((byRubro.get(rubro) || []).reduce((s, x) => s + x.amount, 0));

  const ori = [];
  for (const a of accounts.values()) {
    if (a.account_type !== 'patrimonio' || a.rubro !== 'ori_acumulado') continue;
    const s = oriSums.get(a.id);
    const amt = s ? s.credit - s.debit : 0;
    if (Math.abs(amt) >= 0.005) ori.push({ id: a.id, code: a.code, name: a.name, amount: round2(amt) });
  }

  const ingresos = sum('ingresos_ordinarios');
  const costo = sum('costo_ventas');
  const bruta = round2(ingresos - costo);
  const otrosIngresos = sum('otros_ingresos');
  const gVentas = sum('gastos_ventas');
  const gAdmin = sum('gastos_administracion');
  const otrosGastos = sum('otros_gastos');
  const operacional = round2(bruta + otrosIngresos - gVentas - gAdmin - otrosGastos);
  const ingFin = sum('ingresos_financieros');
  const costFin = sum('costos_financieros');
  const antesImpuestos = round2(operacional + ingFin - costFin);
  const impuesto = sum('impuesto_ganancias');
  const resultado = round2(antesImpuestos - impuesto);
  const oriTotal = round2(ori.reduce((s, x) => s + x.amount, 0));

  return {
    rubros: Object.fromEntries([...byRubro.entries()].map(([k, v]) => [k, { label: RUBRO_BY_CODE[k]?.label || k, total: sum(k), accounts: v }])),
    ori,
    totals: {
      ingresos_ordinarios: ingresos, costo_ventas: costo, ganancia_bruta: bruta,
      otros_ingresos: otrosIngresos, gastos_ventas: gVentas, gastos_administracion: gAdmin, otros_gastos: otrosGastos,
      resultado_operacional: operacional, ingresos_financieros: ingFin, costos_financieros: costFin,
      resultado_antes_impuestos: antesImpuestos, impuesto_ganancias: impuesto, resultado_periodo: resultado,
      otro_resultado_integral: oriTotal, resultado_integral_total: round2(resultado + oriTotal),
    },
  };
}

// Orden de presentación (sección 5.11, por función).
const ERI_LINES = [
  { key: 'ingresos_ordinarios', rubro: 'ingresos_ordinarios', label: 'Ingresos de actividades ordinarias' },
  { key: 'costo_ventas', rubro: 'costo_ventas', label: 'Costo de ventas', negative: true },
  { key: 'ganancia_bruta', label: 'Ganancia bruta', subtotal: true },
  { key: 'otros_ingresos', rubro: 'otros_ingresos', label: 'Otros ingresos' },
  { key: 'gastos_ventas', rubro: 'gastos_ventas', label: 'Gastos de distribución y ventas', negative: true },
  { key: 'gastos_administracion', rubro: 'gastos_administracion', label: 'Gastos de administración', negative: true },
  { key: 'otros_gastos', rubro: 'otros_gastos', label: 'Otros gastos', negative: true },
  { key: 'resultado_operacional', label: 'Resultado de actividades de operación', subtotal: true },
  { key: 'ingresos_financieros', rubro: 'ingresos_financieros', label: 'Ingresos financieros' },
  { key: 'costos_financieros', rubro: 'costos_financieros', label: 'Costos financieros', negative: true },
  { key: 'resultado_antes_impuestos', label: 'Resultado antes de impuestos', subtotal: true },
  { key: 'impuesto_ganancias', rubro: 'impuesto_ganancias', label: 'Gasto por impuesto a las ganancias', negative: true },
  { key: 'resultado_periodo', label: 'Resultado del periodo', subtotal: true, strong: true },
  { key: 'otro_resultado_integral', label: 'Otro resultado integral', ori: true },
  { key: 'resultado_integral_total', label: 'Resultado integral total', subtotal: true, strong: true },
];

async function comprehensiveIncome(tenantId, { from, to, compare_from, compare_to, branch_id } = {}) {
  const f = checkDate(from, 'from');
  const t = checkDate(to, 'to');
  if (f > t) throw badRequest('from no puede ser posterior a to');
  const cf = compare_from ? checkDate(compare_from, 'compare_from') : minusOneYear(f);
  const ct = compare_to ? checkDate(compare_to, 'compare_to') : minusOneYear(t);
  const branchId = checkBranch(branch_id);

  const [accounts, cur, prev] = await Promise.all([
    loadAccounts(tenantId),
    sumsByAccount(tenantId, { from: f, to: t, branchId, close: 'exclude' }),
    sumsByAccount(tenantId, { from: cf, to: ct, branchId, close: 'exclude' }),
  ]);
  const current = buildIncome(accounts, cur, cur);
  const prior = buildIncome(accounts, prev, prev);

  // Líneas listas para pintar: cada una con su detalle por cuenta (actual y anterior).
  const lines = ERI_LINES.map((l) => {
    const line = { ...l, current: current.totals[l.key], prior: prior.totals[l.key] };
    if (l.rubro || l.ori) {
      const curAcc = l.ori ? current.ori : (current.rubros[l.rubro]?.accounts || []);
      const prevAcc = l.ori ? prior.ori : (prior.rubros[l.rubro]?.accounts || []);
      const merged = new Map();
      for (const a of curAcc) merged.set(a.id, { id: a.id, code: a.code, name: a.name, current: a.amount, prior: 0 });
      for (const a of prevAcc) {
        const m = merged.get(a.id) || { id: a.id, code: a.code, name: a.name, current: 0, prior: 0 };
        m.prior = a.amount;
        merged.set(a.id, m);
      }
      line.accounts = [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
    }
    return line;
  });

  return { from: f, to: t, compare_from: cf, compare_to: ct, branch_id: branchId, lines, totals: { current: current.totals, prior: prior.totals } };
}

/* ═════════════════════ Estado de cambios en el patrimonio ═════════════════════ */

async function equityChanges(tenantId, { from, to, branch_id } = {}) {
  const f = checkDate(from, 'from');
  const t = checkDate(to, 'to');
  if (f > t) throw badRequest('from no puede ser posterior a to');
  const branchId = checkBranch(branch_id);
  const openingDate = addDays(f, -1);

  const [accounts, opening, movNoClose, movClose] = await Promise.all([
    loadAccounts(tenantId),
    sumsByAccount(tenantId, { to: openingDate, branchId }),
    sumsByAccount(tenantId, { from: f, to: t, branchId, close: 'exclude' }),
    sumsByAccount(tenantId, { from: f, to: t, branchId, close: 'only' }),
  ]);

  // Columna de cada cuenta: las de resultado van a "Resultado del ejercicio"
  // (resultado aún no cerrado); las de patrimonio, a su rubro.
  const columnOf = (a) => (isPnl(a) ? 'resultado_ejercicio' : a.account_type === 'patrimonio' ? a.rubro : null);
  // Aporte al patrimonio de una cuenta (crédito - débito para todas).
  const equityEffect = (s) => (s ? s.credit - s.debit : 0);

  const rows = {
    saldo_inicial: {}, resultado_periodo: {}, otro_resultado_integral: {}, otros_movimientos: {}, cierre_ejercicio: {}, saldo_final: {},
  };
  const add = (row, col, v) => { if (Math.abs(v) >= 0.005) rows[row][col] = (rows[row][col] || 0) + v; };

  for (const a of accounts.values()) {
    const col = columnOf(a);
    if (!col) continue;
    add('saldo_inicial', col, equityEffect(opening.get(a.id)));
    const mov = equityEffect(movNoClose.get(a.id));
    if (isPnl(a)) add('resultado_periodo', col, mov);
    else if (a.rubro === 'ori_acumulado') add('otro_resultado_integral', col, mov);
    else add('otros_movimientos', col, mov);
    // El cierre anual pasa ingresos/gastos a 3605 (misma columna, neto cero)
    // y el saldo anterior de 3605 a 3705: queda como traslado entre columnas.
    add('cierre_ejercicio', col, equityEffect(movClose.get(a.id)));
  }

  const usedCols = new Set();
  for (const r of Object.values(rows)) for (const k of Object.keys(r)) usedCols.add(k);
  const columns = NIIF_RUBROS.filter((r) => r.section === 'patrimonio' && usedCols.has(r.code))
    .sort((a, b) => rubroOrder.get(a.code) - rubroOrder.get(b.code))
    .map((r) => ({ code: r.code, label: r.label }));

  for (const c of columns) {
    rows.saldo_final[c.code] = ['saldo_inicial', 'resultado_periodo', 'otro_resultado_integral', 'otros_movimientos', 'cierre_ejercicio']
      .reduce((s, k) => s + (rows[k][c.code] || 0), 0);
  }

  const ROW_DEFS = [
    { key: 'saldo_inicial', label: `Saldo al ${openingDate}`, strong: true },
    { key: 'resultado_periodo', label: 'Resultado del periodo' },
    { key: 'otro_resultado_integral', label: 'Otro resultado integral' },
    { key: 'otros_movimientos', label: 'Aportes, distribuciones y otros movimientos' },
    { key: 'cierre_ejercicio', label: 'Traslados por cierre del ejercicio' },
    { key: 'saldo_final', label: `Saldo al ${t}`, strong: true },
  ];
  const outRows = ROW_DEFS.map((d) => {
    const values = Object.fromEntries(columns.map((c) => [c.code, round2(rows[d.key][c.code] || 0)]));
    return { ...d, values, total: round2(Object.values(values).reduce((s, v) => s + v, 0)) };
  });

  return { from: f, to: t, opening_date: openingDate, branch_id: branchId, columns, rows: outRows };
}

module.exports = { financialPosition, comprehensiveIncome, equityChanges, loadAccounts, sumsByAccount, ERI_LINES };
