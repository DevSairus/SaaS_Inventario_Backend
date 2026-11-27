// backend/src/services/finance/cashSessionReport.service.js
//
// Resumen de documentos de una caja (cierre o arqueo), para cuadrar ventas y
// compras que no son solo en efectivo:
//   - Ventas del turno: total facturado, cuánto se recibió por cada medio
//     (efectivo, tarjeta, transferencia, otros, anticipo aplicado,
//     retenciones) y cuánto quedó a crédito.
//   - Abonos de cartera: pagos recibidos en esta caja de ventas de otros días.
//   - Compras y gastos del turno: igual, con lo pagado por medio, retenciones
//     y lo que quedó por pagar al proveedor.
//   - Pagos a proveedores de compras/gastos de otros días.
//
// "Pago de esta caja" = el pago lleva cash_session_id de la caja; los pagos
// sin vínculo (anteriores a ese campo) cuentan si su fecha es la de la caja,
// igual que el cuadre (cashSessions.controller.js#filterBySession).
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Sale, Purchase, Expense, Supplier, Branch, Tenant } = require('../../models');
const { toDateOnly } = require('../../controllers/finance/cashflow.controller');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Medios del cuadre + los que no son dinero que entre o salga de la caja.
const METHOD_KEYS = ['efectivo', 'tarjeta', 'transferencia', 'otro', 'anticipo', 'retenciones', 'saldo_a_favor'];
const emptyMethods = () => Object.fromEntries(METHOD_KEYS.map((k) => [k, 0]));

function normalizeMethod(method) {
  // Misma regla que el cuadre (evita require circular con el controlador).
  const m = String(method || '').toLowerCase().trim();
  if (['efectivo', 'cash', 'contado'].includes(m)) return 'efectivo';
  if (['tarjeta', 'card', 'credit_card', 'debit_card', 'credito', 'debito', 'tarjeta_credito', 'tarjeta_debito', 'tarjeta credito', 'tarjeta debito', 'tarjeta de crédito', 'tarjeta de débito'].includes(m)) return 'tarjeta';
  if (['transferencia', 'transfer', 'transferencia bancaria', 'nequi', 'daviplata', 'pse', 'bancolombia'].includes(m)) return 'transferencia';
  return 'otro';
}

// Balde del pago: los que no mueven dinero van aparte.
function paymentKey(p) {
  if (p.source === 'advance') return 'anticipo';
  if (p.source === 'retention') return 'retenciones';
  if (p.source === 'supplier_credit') return 'saldo_a_favor';
  return normalizeMethod(p.method);
}

function makeIsSessionPayment(session, timeZone) {
  return (p) => (p.cash_session_id
    ? p.cash_session_id === session.id
    : toDateOnly(p.date, timeZone) === session.session_date);
}

const sumMethods = (rows) => {
  const out = emptyMethods();
  rows.forEach((r) => METHOD_KEYS.forEach((k) => { out[k] += r.paid[k] || 0; }));
  Object.keys(out).forEach((k) => { out[k] = round2(out[k]); });
  return out;
};
const sumOf = (rows, key) => round2(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));

// Pagos de esta caja agrupados por medio.
function paidBy(history, isSessionPayment) {
  const paid = emptyMethods();
  (history || []).filter(isSessionPayment).forEach((p) => { paid[paymentKey(p)] += Number(p.amount) || 0; });
  Object.keys(paid).forEach((k) => { paid[k] = round2(paid[k]); });
  return paid;
}
const paidTotal = (paid) => round2(Object.values(paid).reduce((s, v) => s + v, 0));

// Filas con algún pago ligado a esta caja (aunque el documento sea de otro día).
const linkedToSession = (alias, sessionId) => sequelize.literal(
  `(jsonb_typeof("${alias}"."payment_history") = 'array' AND "${alias}"."payment_history" @> ${sequelize.escape(JSON.stringify([{ cash_session_id: sessionId }]))}::jsonb)`,
);
// Algún pago sin vínculo en la fecha de la caja (prefiltro amplio: ±1 día).
const legacyOnDay = (alias, day) => sequelize.literal(`EXISTS (
  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("${alias}"."payment_history") = 'array' THEN "${alias}"."payment_history" ELSE '[]'::jsonb END) AS h(e)
  WHERE NOT (h.e ? 'cash_session_id')
    AND split_part(split_part(h.e->>'date', 'T', 1), ' ', 1) BETWEEN ${sequelize.escape(shift(day, -1))} AND ${sequelize.escape(shift(day, 1))})`);
function shift(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param session CashSession (instancia o JSON)
 */
async function buildSessionReport(session) {
  const tenantId = session.tenant_id;
  const day = String(session.session_date).slice(0, 10);
  const from = new Date(session.opened_at);
  const to = session.closed_at ? new Date(session.closed_at) : new Date();

  const [tenant, activeBranches] = await Promise.all([
    Tenant.findByPk(tenantId, { attributes: ['id', 'business_config'] }),
    Branch.count({ where: { tenant_id: tenantId, is_active: true } }),
  ]);
  const timeZone = tenant?.business_config?.timezone || 'America/Bogota';
  const isSessionPayment = makeIsSessionPayment(session, timeZone);
  // Compras/gastos sin sede: solo con una sede activa se sabe que son de esta caja.
  const branchWhere = activeBranches <= 1
    ? { [Op.or]: [{ branch_id: session.branch_id }, { branch_id: null }] }
    : { branch_id: session.branch_id };
  const createdInSession = { created_at: { [Op.between]: [from, to] } };
  const withPaymentHere = (alias) => ({ [Op.or]: [linkedToSession(alias, session.id), legacyOnDay(alias, day)] });

  const [sales, purchases, expenses] = await Promise.all([
    Sale.findAll({
      where: {
        tenant_id: tenantId,
        branch_id: session.branch_id,
        document_type: ['factura', 'remision'],
        is_consolidated_invoice: false, // documento fiscal de remisiones ya contadas
        status: { [Op.in]: ['pending', 'completed'] },
        [Op.or]: [createdInSession, withPaymentHere('Sale')],
      },
      attributes: ['id', 'sale_number', 'dian_invoice_number', 'document_type', 'customer_name', 'total_amount', 'returned_amount', 'payment_history', 'created_at'],
      order: [['created_at', 'ASC']],
    }),
    Purchase.findAll({
      where: {
        tenant_id: tenantId,
        status: { [Op.in]: ['confirmed', 'partially_received', 'received'] },
        [Op.or]: [{ [Op.and]: [createdInSession, branchWhere] }, linkedToSession('Purchase', session.id), { [Op.and]: [legacyOnDay('Purchase', day), branchWhere] }],
      },
      include: [{ model: Supplier, as: 'supplier', attributes: ['name'] }],
      attributes: ['id', 'purchase_number', 'invoice_number', 'total_amount', 'total_retentions', 'payment_history', 'created_at'],
      order: [['created_at', 'ASC']],
    }),
    Expense.findAll({
      where: {
        tenant_id: tenantId,
        [Op.or]: [{ [Op.and]: [createdInSession, branchWhere] }, linkedToSession('Expense', session.id), { [Op.and]: [legacyOnDay('Expense', day), branchWhere] }],
      },
      attributes: ['id', 'expense_number', 'description', 'total_amount', 'total_retentions', 'payment_history', 'created_at'],
      order: [['created_at', 'ASC']],
    }),
  ]);

  // underscored: la fecha llega como createdAt o created_at según el modelo.
  const createdAtOf = (doc) => doc.createdAt || doc.created_at || doc.get?.('created_at') || doc.get?.('createdAt');
  const inWindow = (doc) => {
    const at = new Date(createdAtOf(doc));
    return at >= from && at <= to;
  };

  // ── Ventas ──
  const saleRows = [];
  const collectionRows = [];
  sales.forEach((s) => {
    const paid = paidBy(s.payment_history, isSessionPayment);
    const total = round2(Number(s.total_amount) - Number(s.returned_amount || 0));
    const number = s.dian_invoice_number || s.sale_number;
    if (inWindow(s)) {
      saleRows.push({ id: s.id, number, document_type: s.document_type, party: s.customer_name, total, paid, credit: round2(Math.max(total - paidTotal(paid), 0)) });
    } else if (paidTotal(paid) > 0) {
      collectionRows.push({ id: s.id, number, party: s.customer_name, total: paidTotal(paid), paid });
    }
  });

  // ── Compras y gastos (lo que se le debe al proveedor es el neto de retenciones) ──
  const docRows = (docs, kind) => {
    const today = [];
    const older = [];
    docs.forEach((d) => {
      const paid = paidBy(d.payment_history, isSessionPayment);
      const total = round2(d.total_amount);
      const retentions = round2(d.total_retentions || 0);
      const base = kind === 'purchase'
        ? { id: d.id, number: d.purchase_number, reference: d.invoice_number || null, party: d.supplier?.name || 'Proveedor' }
        : { id: d.id, number: d.expense_number, reference: null, party: d.description || 'Gasto' };
      if (inWindow(d)) {
        today.push({ ...base, total, retentions, paid, credit: round2(Math.max(total - retentions - paidTotal(paid), 0)) });
      } else if (paidTotal(paid) > 0) {
        older.push({ ...base, total: paidTotal(paid), paid });
      }
    });
    return { today, older };
  };
  const p = docRows(purchases, 'purchase');
  const e = docRows(expenses, 'expense');

  const block = (rows, { withCredit = true, withRetentions = false } = {}) => ({
    count: rows.length,
    total: sumOf(rows, 'total'),
    ...(withRetentions && { retentions: sumOf(rows, 'retentions') }),
    by_method: sumMethods(rows),
    ...(withCredit && { credit: sumOf(rows, 'credit') }),
    items: rows,
  });

  return {
    sales: block(saleRows),
    collections: block(collectionRows, { withCredit: false }),
    purchases: block(p.today, { withRetentions: true }),
    supplier_payments: block(p.older, { withCredit: false }),
    expenses: block(e.today, { withRetentions: true }),
    expense_payments: block(e.older, { withCredit: false }),
  };
}

/**
 * Cuadre por medio de pago a partir de los movimientos de la caja:
 * entradas, salidas y esperado (efectivo suma la base de apertura).
 */
function methodMatrix(transactions, openingAmount) {
  const keys = ['efectivo', 'tarjeta', 'transferencia', 'otro'];
  const rows = Object.fromEntries(keys.map((k) => [k, { in: 0, out: 0, expected: 0 }]));
  (transactions || []).forEach((t) => {
    const r = rows[normalizeMethod(t.method)];
    if (t.direction === 'in') r.in += Number(t.amount) || 0; else r.out += Number(t.amount) || 0;
  });
  keys.forEach((k) => {
    rows[k].in = round2(rows[k].in);
    rows[k].out = round2(rows[k].out);
    // Solo las salidas en efectivo restan (ver cashSessions.controller#calculateExpected);
    // las demás se informan.
    rows[k].expected = round2((k === 'efectivo' ? Number(openingAmount) || 0 : 0) + rows[k].in - (k === 'efectivo' ? rows[k].out : 0));
  });
  return rows;
}

module.exports = { buildSessionReport, methodMatrix, METHOD_KEYS, paymentKey };
