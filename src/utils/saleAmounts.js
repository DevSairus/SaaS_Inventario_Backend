// backend/src/utils/saleAmounts.js
//
// Saldo por cobrar de una venta. returned_amount es la parte de la cartera
// que se canceló con devoluciones aprobadas (approveCustomerReturn) -- sin
// restarla, Cuentas por Cobrar seguía cobrando mercancía ya devuelta.

'use strict';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Total que realmente se le puede cobrar al cliente (total - devuelto). */
function saleCollectibleTotal(sale) {
  return round2(Math.max(Number(sale?.total_amount || 0) - Number(sale?.returned_amount || 0), 0));
}

/** Saldo pendiente (cobrable - pagado), nunca negativo. */
function saleBalance(sale) {
  return round2(Math.max(saleCollectibleTotal(sale) - Number(sale?.paid_amount || 0), 0));
}

/**
 * Parte del saldo que es retención de garantía todavía no liberada (facturas
 * parciales de obra, services/projects/projectCuts.service.js): el cliente la
 * debe, pero no vence hasta la entrega. Los pagos cubren primero lo demás.
 */
function saleRetentionPending(sale) {
  if (sale?.retention_released_at) return 0;
  return round2(Math.min(Number(sale?.retention_guarantee_amount || 0), saleBalance(sale)));
}

/** Saldo que sí vence (sin la retención de garantía pendiente). */
function saleDueBalance(sale) {
  return round2(saleBalance(sale) - saleRetentionPending(sale));
}

/** 'pending' | 'partial' | 'paid' para un paid_amount dado. */
function salePaymentStatus(sale, paidAmount = sale?.paid_amount) {
  const paid = Number(paidAmount || 0);
  if (paid >= saleCollectibleTotal(sale) - 0.005) return 'paid';
  return paid > 0 ? 'partial' : 'pending';
}

module.exports = { saleCollectibleTotal, saleBalance, saleRetentionPending, saleDueBalance, salePaymentStatus, round2 };
