// backend/src/services/finance/customerAdvance.service.js
//
// Creación de anticipos de cliente, compartida por:
//  - POST /customer-advances (anticipo recibido directamente)
//  - registro de pago de una factura/remisión cuando el cliente paga de más
//    y decide dejar el excedente como anticipo (registerPayment / confirm)

const { CustomerAdvance, Customer } = require('../../models');
const { generateAdvanceNumber } = require('./advanceNumber.service');
const { resolveSelectedBankAccountId } = require('../accounting/bankAccountSelection');
const logger = require('../../config/logger');

// Los modales de venta usan códigos (cash, transfer...) y el módulo de
// anticipos etiquetas en español: el anticipo guarda la etiqueta.
const METHOD_LABELS = {
  cash: 'Efectivo',
  efectivo: 'Efectivo',
  credit_card: 'Tarjeta de Crédito',
  debit_card: 'Tarjeta de Débito',
  card: 'Tarjeta de Crédito',
  transfer: 'Transferencia',
  transferencia: 'Transferencia',
  check: 'Cheque',
  cheque: 'Cheque',
};

const advanceMethodLabel = (method) => METHOD_LABELS[String(method || '').toLowerCase()] || method || 'Efectivo';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Crea el anticipo dentro de la transacción recibida. No genera el asiento:
 * después del commit el llamador debe invocar `afterAdvanceCommitted`.
 */
async function createCustomerAdvanceRecord({
  tenantId, branchId, userId, customerId, amount, method, bankAccountId,
  receivedDate, referenceNote, triggersIva = false, cashSessionId = null,
}, transaction) {
  const value = Math.round(parseFloat(amount) * 100) / 100;
  if (!customerId) throw httpError(400, 'El cliente es obligatorio para registrar un anticipo');
  if (!(value > 0)) throw httpError(400, 'El monto del anticipo debe ser mayor a 0');

  const customer = await Customer.findOne({ where: { id: customerId, tenant_id: tenantId }, attributes: ['id'], transaction });
  if (!customer) throw httpError(404, 'Cliente no encontrado');

  const methodLabel = advanceMethodLabel(method);
  const selectedBankAccountId = await resolveSelectedBankAccountId(tenantId, bankAccountId, methodLabel, transaction);
  const advance_number = await generateAdvanceNumber(tenantId, transaction);

  return CustomerAdvance.create({
    tenant_id: tenantId,
    branch_id: branchId,
    customer_id: customerId,
    advance_number,
    amount: value,
    applied_amount: 0,
    refunded_amount: 0,
    balance: value,
    method: methodLabel,
    bank_account_id: selectedBankAccountId,
    // 'YYYY-MM-DD' se interpreta como medianoche UTC y en Colombia (UTC-5)
    // caía el día anterior (también en el asiento): se fija al mediodía local.
    received_date: typeof receivedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(receivedDate)
      ? new Date(`${receivedDate}T12:00:00`)
      : (receivedDate || new Date()),
    cash_session_id: cashSessionId,
    reference_note: referenceNote || null,
    triggers_iva: !!triggersIva,
    status: 'active',
    created_by: userId,
  }, { transaction });
}

/** Asiento contable + chequeo de alertas, fuera de la transacción (fire-and-forget). */
function afterAdvanceCommitted(advances, tenantId, userId) {
  const list = (Array.isArray(advances) ? advances : [advances]).filter(Boolean);
  if (!list.length) return;
  const { markAdvanceForAlertCheck } = require('../../middleware/autoCheckAdvanceAlerts.middleware');
  setImmediate(async () => {
    const { generateAdvanceEntry } = require('../accounting/autoEntries.service');
    for (const advance of list) {
      try {
        await generateAdvanceEntry(advance, tenantId, userId);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de anticipo (${advance.id}): ${err.message}`);
      }
    }
  });
  for (const advance of list) markAdvanceForAlertCheck(advance.id, tenantId);
}

/**
 * Reparte un excedente entre los medios de un pago mixto, empezando por el
 * último (lo que "sobró" es lo último que se recibió). Devuelve los splits
 * reducidos (sin los que quedan en 0) y las partes que van al anticipo.
 */
function splitExcess(splits, excess) {
  let left = Math.round(excess * 100) / 100;
  const kept = splits.map(s => ({ ...s }));
  const advanceParts = [];
  for (let i = kept.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(kept[i].amount, left);
    if (take <= 0) continue;
    kept[i].amount = Math.round((kept[i].amount - take) * 100) / 100;
    left = Math.round((left - take) * 100) / 100;
    advanceParts.unshift({ method: kept[i].method, amount: take, bank_account_id: kept[i].bank_account_id || null });
  }
  return { splits: kept.filter(s => s.amount > 0), advanceParts, unassigned: left };
}

module.exports = {
  advanceMethodLabel,
  createCustomerAdvanceRecord,
  afterAdvanceCommitted,
  splitExcess,
};
