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

/**
 * Saldo pendiente con el proveedor (neto - pagado - devuelto), nunca
 * negativo. returned_amount = parte no pagada cancelada por devoluciones a
 * proveedor aprobadas (supplierReturns.controller.js).
 */
function purchaseBalance(purchase) {
  return round2(Math.max(
    purchaseNetPayable(purchase) - Number(purchase?.paid_amount || 0) - Number(purchase?.returned_amount || 0),
    0
  ));
}

/** 'pending' | 'partial' | 'paid' según lo pagado contra el neto (menos lo devuelto). */
function purchasePaymentStatus(purchase, paidAmount) {
  const paid = Number(paidAmount ?? purchase?.paid_amount ?? 0);
  const net = Math.max(purchaseNetPayable(purchase) - Number(purchase?.returned_amount || 0), 0);
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

// Plazo por defecto cuando la compra no trae due_date (proveedor sin
// payment_terms): mismo criterio de 30 días que usa Cartera.
const DEFAULT_PAYABLE_TERM_DAYS = 30;

/**
 * Fecha de vencimiento efectiva ('YYYY-MM-DD'): due_date si existe; si no,
 * purchase_date + 30 días. Única regla para Cuentas por Pagar, antigüedad y
 * alertas -- antes CxP sumaba 30 días y las alertas usaban la fecha de compra.
 */
function purchaseEffectiveDueDate(purchase) {
  if (purchase?.due_date) return String(purchase.due_date).slice(0, 10);
  if (!purchase?.purchase_date) return null;
  const d = new Date(`${String(purchase.purchase_date).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + DEFAULT_PAYABLE_TERM_DAYS);
  return d.toISOString().slice(0, 10);
}

/** Días vencidos respecto a hoy (negativo = aún no vence). */
function purchaseDaysOverdue(purchase, today = new Date()) {
  const due = purchaseEffectiveDueDate(purchase);
  if (!due) return 0;
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((todayUtc - new Date(`${due}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Reparte una devolución a proveedor en parte ya pagada y parte pendiente,
 * en la proporción pagada del neto de la compra. Misma regla en el
 * controlador (cartera, caja) y en el asiento (generateSupplierReturnEntry).
 */
function purchaseReturnSplit(purchase, returnTotal) {
  const total = round2(Number(returnTotal || 0));
  const net = purchaseNetPayable(purchase);
  const paid = Math.min(Number(purchase?.paid_amount || 0), net);
  const ratio = net > 0 ? paid / net : 0;
  const paidPart = round2(total * ratio);
  return { paid: paidPart, pending: round2(total - paidPart) };
}

module.exports = {
  purchaseNetPayable, purchaseBalance, purchasePaymentStatus, isPayablePurchase, payablePurchaseWhere, round2,
  DEFAULT_PAYABLE_TERM_DAYS, purchaseEffectiveDueDate, purchaseDaysOverdue, purchaseReturnSplit,
};
