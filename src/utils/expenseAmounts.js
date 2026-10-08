// backend/src/utils/expenseAmounts.js
//
// Lo que realmente se le debe al proveedor por un gasto: el total menos las
// retenciones que el tenant le practicó (esas se le deben a la DIAN). Mismo
// criterio que utils/purchaseAmounts.js. El asiento del gasto ya acredita
// expense_payable (o caja/bancos) solo por el neto; antes el registro de
// abonos permitía pagar el total bruto y dejaba 2335 con saldo negativo.

'use strict';

const { round2 } = require('./purchaseAmounts');

/** Neto a pagar al proveedor (total - retenciones). */
function expenseNetPayable(expense) {
  const total = Number(expense?.total_amount || 0);
  const retentions = Number(expense?.total_retentions || 0);
  return round2(Math.max(total - retentions, 0));
}

/** Saldo pendiente con el proveedor (neto - pagado), nunca negativo. */
function expenseBalance(expense) {
  return round2(Math.max(expenseNetPayable(expense) - Number(expense?.paid_amount || 0), 0));
}

/** 'pending' | 'partial' | 'paid' según lo pagado contra el neto. */
function expensePaymentStatus(expense, paidAmount) {
  const paid = Number(paidAmount ?? expense?.paid_amount ?? 0);
  const net = expenseNetPayable(expense);
  if (paid >= net - 0.01) return 'paid';
  if (paid > 0) return 'partial';
  return 'pending';
}

module.exports = { expenseNetPayable, expenseBalance, expensePaymentStatus };
