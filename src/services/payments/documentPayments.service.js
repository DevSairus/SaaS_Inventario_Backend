// backend/src/services/payments/documentPayments.service.js
//
// Registrar un pago a una compra o a un gasto. Lo usan el pago manual
// (accountsPayable.controller.js#registerPayment, expenses.controller.js#
// registerPayment) y los lotes de pago (paymentBatches.service.js), para que
// los dos dejen exactamente el mismo registro y el mismo asiento.
//
// Cada función trabaja dentro de la transacción del llamador y devuelve una
// función `afterCommit` con el asiento contable (no bloqueante: si falla, el
// pago queda registrado y se loguea, igual que antes).

const logger = require('../../config/logger');
const { Purchase, Expense } = require('../../models');
const { purchaseBalance, purchasePaymentStatus, round2 } = require('../../utils/purchaseAmounts');
const { expenseBalance, expensePaymentStatus } = require('../../utils/expenseAmounts');
const { resolveSelectedBankAccountId } = require('../accounting/bankAccountSelection');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/**
 * @returns {{ document, payment, amount, afterCommit: () => Promise<void> }}
 */
async function registerPurchasePayment({ tenantId, userId, purchaseId, amount, method, date, notes, bankAccountId, extra = {} }, transaction) {
  if (!amount || parseFloat(amount) <= 0) throw httpError(400, 'El monto debe ser mayor a 0');
  // SELECT FOR UPDATE: evita que dos pagos concurrentes lean el mismo paid_amount
  const purchase = await Purchase.findOne({ where: { id: purchaseId, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
  if (!purchase) throw httpError(404, 'Compra no encontrada');
  if (purchase.status === 'draft' || purchase.status === 'cancelled') {
    throw httpError(400, 'No se puede registrar un pago en una compra en borrador o cancelada');
  }
  // Lo que se le debe al proveedor es el neto de retenciones (ver utils/purchaseAmounts.js).
  const remaining = purchaseBalance(purchase);
  if (remaining <= 0) throw httpError(400, 'Esta compra ya está pagada en su totalidad');

  const effectiveAmount = round2(Math.min(parseFloat(amount), remaining));
  const paid_amount = round2(parseFloat(purchase.paid_amount || 0) + effectiveAmount);
  const payment = {
    id: require('crypto').randomUUID(),
    date: date || new Date(),
    amount: effectiveAmount,
    method: method || purchase.payment_method || 'Efectivo',
    bank_account_id: bankAccountId || null,
    user_id: userId,
    notes: notes || null,
    journal_entry_id: null,
    ...extra,
  };
  await purchase.update({
    paid_amount,
    payment_status: purchasePaymentStatus(purchase, paid_amount),
    payment_method: method || purchase.payment_method,
    payment_history: [...(purchase.payment_history || []), payment],
  }, { transaction });

  return {
    document: purchase,
    payment,
    amount: effectiveAmount,
    // Asiento del pago (débito proveedores / crédito caja-bancos).
    afterCommit: async () => {
      try {
        const { recordPurchasePaymentEntries } = require('../inventory/purchasePayments.service');
        await recordPurchasePaymentEntries(purchase.id, tenantId, userId);
      } catch (e) {
        logger.warn(`[accounting] Asiento de pago a proveedor (compra ${purchase.id}): ${e.message}`);
      }
    },
  };
}

async function registerExpensePayment({ tenantId, userId, expenseId, amount, method, date, notes, bankAccountId, extra = {} }, transaction) {
  if (!amount || parseFloat(amount) <= 0) throw httpError(400, 'El monto debe ser mayor a 0');
  const expense = await Expense.findOne({ where: { id: expenseId, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
  if (!expense) throw httpError(404, 'Gasto no encontrado');
  // Lo que se le debe al proveedor es el neto de retenciones (ver utils/expenseAmounts.js).
  const remaining = expenseBalance(expense);
  if (remaining <= 0) throw httpError(400, 'Este gasto ya está pagado en su totalidad');

  const effectiveAmount = Math.round(Math.min(parseFloat(amount), remaining) * 100) / 100;
  const paid_amount = Math.round((parseFloat(expense.paid_amount || 0) + effectiveAmount) * 100) / 100;
  const effectiveMethod = method || expense.payment_method || 'Efectivo';
  const selectedBankAccountId = await resolveSelectedBankAccountId(tenantId, bankAccountId, effectiveMethod, transaction);
  const payment = {
    date: date || new Date(),
    amount: effectiveAmount,
    method: effectiveMethod,
    bank_account_id: selectedBankAccountId,
    user_id: userId,
    notes: notes || null,
    ...extra,
  };
  await expense.update({
    paid_amount,
    payment_status: expensePaymentStatus(expense, paid_amount),
    payment_method: method || expense.payment_method,
    payment_history: [...(expense.payment_history || []), payment],
  }, { transaction });

  return {
    document: expense,
    payment,
    amount: effectiveAmount,
    // Asiento del abono (cuentas por pagar vs caja/bancos).
    afterCommit: async () => {
      try {
        const { generateExpensePaymentEntry } = require('../accounting/autoEntries.service');
        await generateExpensePaymentEntry(expense, payment, tenantId, userId);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de pago de gasto ${expense.id}: ${err.message}`);
      }
    },
  };
}

module.exports = { registerPurchasePayment, registerExpensePayment };
