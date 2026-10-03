// backend/src/utils/purchaseAmounts.js
//
// Lo que realmente se le debe al proveedor por una compra: el total menos
// las retenciones que el tenant le practicó (esas se le deben a la DIAN, no
// al proveedor). Antes cuentas por pagar, el registro de pagos y las
// alertas usaban total_amount: con retenciones, la compra nunca quedaba
// "pagada" pagando lo correcto, y el modal de pago sugería pagar de más.

'use strict';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Neto a pagar al proveedor (total - retenciones). */
function purchaseNetPayable(purchase) {
  const total = Number(purchase?.total_amount || 0);
  const retentions = Number(purchase?.total_retentions || 0);
  return round2(Math.max(total - retentions, 0));
}

/** Saldo pendiente con el proveedor (neto - pagado), nunca negativo. */
function purchaseBalance(purchase) {
  return round2(Math.max(purchaseNetPayable(purchase) - Number(purchase?.paid_amount || 0), 0));
}

/** 'pending' | 'partial' | 'paid' según lo pagado contra el neto. */
function purchasePaymentStatus(purchase, paidAmount) {
  const paid = Number(paidAmount ?? purchase?.paid_amount ?? 0);
  const net = purchaseNetPayable(purchase);
  if (paid >= net - 0.01) return 'paid';
  if (paid > 0) return 'partial';
  return 'pending';
}

/**
 * ¿La compra ya es una obligación con el proveedor (cuenta por pagar)?
 * Una orden confirmada es solo un pedido: la deuda nace cuando llega la
 * mercancía (recibida total o parcialmente) o cuando se registra la factura
 * del proveedor (invoice_number — ej. compras importadas de la DIAN, que
 * traen factura aunque la mercancía aún no se haya recibido).
 */
function isPayablePurchase(purchase) {
  if (['partially_received', 'received'].includes(purchase?.status)) return true;
  return purchase?.status === 'confirmed' && !!String(purchase?.invoice_number || '').trim();
}

/** Mismo criterio que isPayablePurchase, como filtro de Sequelize. */
function payablePurchaseWhere() {
  const { Op } = require('sequelize');
  return {
    [Op.or]: [
      { status: { [Op.in]: ['partially_received', 'received'] } },
      { status: 'confirmed', invoice_number: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] } },
    ],
  };
}

module.exports = { purchaseNetPayable, purchaseBalance, purchasePaymentStatus, isPayablePurchase, payablePurchaseWhere, round2 };
