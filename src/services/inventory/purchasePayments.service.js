// backend/src/services/inventory/purchasePayments.service.js
//
// Asientos de los pagos a proveedores registrados en purchase.payment_history.
//
// Cada pago nuevo se guarda con `journal_entry_id: null` y aquí se le genera
// su asiento (débito Proveedores / crédito Caja-Bancos, ver
// autoEntries.generatePurchasePaymentEntry). Los pagos de antes de este
// cambio no tienen la llave `journal_entry_id` en absoluto: se dejan quietos,
// porque con la lógica anterior el asiento de recepción de una compra ya
// pagada acreditaba Caja directamente — generarles asiento ahora duplicaría
// la salida de caja.
//
// Una compra en borrador no genera asientos de pago (el pago de contado se
// marca al crearla, pero la compra todavía puede editarse o eliminarse): se
// generan al confirmarla o recibirla.

'use strict';

const logger = require('../../config/logger');

const PENDING_STATUSES = ['confirmed', 'partially_received', 'received'];

/**
 * Genera los asientos que falten para los pagos de una compra.
 * @returns {Promise<number>} cantidad de asientos generados
 */
async function recordPurchasePaymentEntries(purchaseId, tenantId, userId) {
  const { Purchase } = require('../../models');
  const { generatePurchasePaymentEntry } = require('../accounting/autoEntries.service');

  const purchase = await Purchase.findOne({ where: { id: purchaseId, tenant_id: tenantId } });
  if (!purchase || !PENDING_STATUSES.includes(purchase.status)) return 0;

  const history = Array.isArray(purchase.payment_history) ? purchase.payment_history.map((p) => ({ ...p })) : [];
  let generated = 0;
  for (const payment of history) {
    // Solo pagos registrados con el esquema nuevo y aún sin asiento.
    if (!Object.prototype.hasOwnProperty.call(payment, 'journal_entry_id') || payment.journal_entry_id) continue;
    if (!(Number(payment.amount) > 0)) continue;
    const entry = await generatePurchasePaymentEntry(purchase, payment, tenantId, userId);
    if (entry?.id) {
      payment.journal_entry_id = entry.id;
      generated += 1;
    } else {
      logger.warn(`[accounting] No se generó el asiento del pago ${payment.id || ''} de la compra ${purchase.purchase_number}`);
    }
  }
  if (generated > 0) {
    // Se relee para no pisar un pago registrado en paralelo mientras se
    // generaban los asientos: solo se copian los journal_entry_id nuevos.
    const fresh = await Purchase.findByPk(purchase.id);
    const byId = new Map(history.filter((p) => p.id).map((p) => [p.id, p.journal_entry_id]));
    const merged = (fresh.payment_history || []).map((p) => (p.id && byId.get(p.id) && !p.journal_entry_id ? { ...p, journal_entry_id: byId.get(p.id) } : p));
    await fresh.update({ payment_history: merged });
  }
  return generated;
}

/** Registro de pago con el esquema nuevo (con id y journal_entry_id). */
function newPaymentRecord({ date, amount, method, bank_account_id, user_id, notes }) {
  return {
    id: require('crypto').randomUUID(),
    date: date || new Date(),
    amount: Math.round(Number(amount) * 100) / 100,
    method: method || 'Efectivo',
    bank_account_id: bank_account_id || null,
    user_id: user_id || null,
    notes: notes || null,
    journal_entry_id: null,
  };
}

module.exports = { recordPurchasePaymentEntries, newPaymentRecord };
