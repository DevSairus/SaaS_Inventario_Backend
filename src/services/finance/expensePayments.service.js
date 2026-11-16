// backend/src/services/finance/expensePayments.service.js
//
// Asientos de los PAGOS de un gasto (débito cuentas por pagar / crédito caja o
// bancos). Mismo esquema que las compras (inventory/purchasePayments.service.js):
// cada pago del payment_history lleva `id` y `journal_entry_id`.
//
// Por qué existe: el asiento del pago se generaba después del commit y, si
// fallaba (período contable cerrado, falta un mapeo de cuentas), solo quedaba
// en el log. El gasto aparecía pagado sin asiento del pago y Salud Contable no
// lo detectaba, porque solo revisaba el asiento del gasto.
//
// Pagos que NO llevan asiento propio: los gastos registrados como pagados
// ANTES del 2026-11-16, cuyo asiento del gasto ya acreditó caja o bancos. Se
// reconocen porque su pago inicial no trae journal_entry_id (esquema viejo).
// Desde esa fecha el pago inicial lleva su propio asiento, como cualquier pago.

const logger = require('../../config/logger');

const INITIAL_PAYMENT_NOTE = 'Pago al momento de registrar el gasto';

const isInitialPayment = (p) => !!p?.in_expense_entry
  || (p?.notes === INITIAL_PAYMENT_NOTE && !Object.prototype.hasOwnProperty.call(p, 'journal_entry_id'));
const cents = (v) => Math.round(Number(v || 0) * 100);

/**
 * Pagos del gasto que no tienen asiento: los que no tienen journal_entry_id y
 * cuyo monto no casa con ningún asiento expense_payment vigente del gasto (los
 * pagos viejos no guardaban journal_entry_id: se emparejan por monto).
 * @returns {Promise<Array<{ index: number, payment: object }>>}
 */
async function pendingExpensePayments(expense, transaction) {
  const { JournalEntry, JournalEntryLine } = require('../../models');
  const history = Array.isArray(expense.payment_history) ? expense.payment_history : [];
  const candidates = history
    .map((payment, index) => ({ index, payment }))
    .filter(({ payment }) => !isInitialPayment(payment) && Number(payment.amount) > 0 && !payment.journal_entry_id);
  if (!candidates.length) return [];

  const entries = await JournalEntry.findAll({
    where: { tenant_id: expense.tenant_id, source_type: 'expense_payment', source_id: expense.id, status: ['draft', 'posted'] },
    include: [{ model: JournalEntryLine, as: 'lines', attributes: ['debit'] }],
    transaction,
  });
  const linked = new Set(history.map((p) => p.journal_entry_id).filter(Boolean));
  // Montos de los asientos que no están ya amarrados a un pago (cada uno se usa una vez).
  const free = entries
    .filter((e) => !linked.has(e.id))
    .map((e) => cents((e.lines || []).reduce((s, l) => s + Number(l.debit || 0), 0)));

  const pending = [];
  for (const c of candidates) {
    const i = free.indexOf(cents(c.payment.amount));
    if (i >= 0) free.splice(i, 1);
    else pending.push(c);
  }
  return pending;
}

/**
 * Genera el asiento de cada pago del gasto que no lo tenga y deja su
 * journal_entry_id en el payment_history. Con `rethrow`, el primer error sube
 * (para mostrarlo al usuario); sin él, se loguea y sigue.
 * @returns {Promise<{ generated: number, errors: string[] }>}
 */
async function recordExpensePaymentEntries(expenseId, tenantId, userId, { rethrow = false } = {}) {
  const { Expense } = require('../../models');
  const { generateExpensePaymentEntry } = require('../accounting/autoEntries.service');
  const expense = await Expense.findOne({ where: { id: expenseId, tenant_id: tenantId } });
  if (!expense) return { generated: 0, errors: [] };

  const pending = await pendingExpensePayments(expense);
  const created = new Map(); // index -> entry id
  const errors = [];
  for (const { index, payment } of pending) {
    try {
      const entry = await generateExpensePaymentEntry(expense, payment, tenantId, userId, { rethrow: true });
      if (entry?.id) created.set(index, entry.id);
    } catch (err) {
      errors.push(err.message);
      logger.warn(`[accounting] Sin asiento el pago de ${payment.amount} del gasto ${expense.expense_number || expense.id}: ${err.message}`);
      if (rethrow) break;
    }
  }

  if (created.size) {
    // Se relee para no pisar un pago registrado en paralelo.
    const fresh = await Expense.findByPk(expense.id);
    const history = (fresh.payment_history || []).map((p, i) => (created.has(i) && !p.journal_entry_id
      ? { ...p, id: p.id || require('crypto').randomUUID(), journal_entry_id: created.get(i) }
      : p));
    await fresh.update({ payment_history: history });
  }
  if (rethrow && errors.length) {
    const err = new Error(errors[0]);
    err.statusCode = 400;
    throw err;
  }
  return { generated: created.size, errors };
}

module.exports = { recordExpensePaymentEntries, pendingExpensePayments, isInitialPayment, INITIAL_PAYMENT_NOTE };
