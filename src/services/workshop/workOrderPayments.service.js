// backend/src/services/workshop/workOrderPayments.service.js
//
// Abonos cobrados en una OT (WorkOrder.payment_history) que dejan de ser
// "abonos de la OT": al facturarla pasan a la venta; lo que exceda el total
// facturado, o todo si la OT se cancela, se convierte en anticipo del
// cliente (CustomerAdvance) para que el dinero quede trazable y se pueda
// aplicar a otra factura o devolver.
//
// Contabilidad: un abono con asiento propio (generateWorkOrderPaymentEntry,
// source 'work_order_payment') ya está en 2805 Anticipos de clientes, así
// que el anticipo que lo hereda no genera asiento nuevo. Uno sin asiento
// (abonos de antes de ese asiento) genera el asiento normal de anticipo
// (D Caja/Bancos - C 2805).

const { Op } = require('sequelize');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Parte de un abono de OT que sigue siendo de la OT (no pasada a anticipo). */
function transferableAmount(payment) {
  return round2(Number(payment.amount || 0) - Number(payment.moved_to_advance_amount || 0));
}

/** payment_ids que ya tienen asiento propio de abono a OT. */
async function accountedPaymentIds(tenantId, paymentIds, transaction) {
  const ids = paymentIds.filter(Boolean);
  if (!ids.length) return new Set();
  const { JournalEntry } = require('../../models');
  const entries = await JournalEntry.findAll({
    where: { tenant_id: tenantId, source_type: 'work_order_payment', source_id: { [Op.in]: ids } },
    attributes: ['source_id'],
    transaction,
  });
  return new Set(entries.map((e) => e.source_id));
}

/**
 * Crea un anticipo por cada porción. Devuelve [{ advance, accounted, payment_id }]
 * para llamar a generateMovedAdvanceEntries después del commit.
 *
 * @param {object[]} portions - [{ payment, amount, accounted }]
 */
async function moveToAdvances({ order, portions, tenantId, userId, branchId, reason, transaction }) {
  const { CustomerAdvance } = require('../../models');
  const { generateAdvanceNumber } = require('../finance/advanceNumber.service');
  const results = [];
  for (const { payment, amount, accounted } of portions) {
    const value = round2(amount);
    if (value <= 0) continue;
    const advance = await CustomerAdvance.create({
      tenant_id: tenantId,
      branch_id: payment.branch_id || branchId,
      customer_id: order.customer_id,
      advance_number: await generateAdvanceNumber(tenantId, transaction),
      amount: value,
      applied_amount: 0,
      refunded_amount: 0,
      balance: value,
      method: payment.method || 'Efectivo',
      bank_account_id: payment.bank_account_id || null,
      // Fecha y caja del abono original: el dinero entró ese día (flujo de
      // caja / cuadre lo cuentan por este lado en vez de por la OT).
      received_date: payment.date || new Date(),
      cash_session_id: payment.cash_session_id || null,
      reference_note: reason,
      triggers_iva: false,
      work_order_id: order.id,
      status: 'active',
      created_by: userId,
    }, { transaction });
    results.push({ advance, accounted: !!accounted, payment_id: payment.payment_id || null });
  }
  return results;
}

/** Asiento de anticipo solo para los que venían de abonos sin asiento propio. */
async function generateMovedAdvanceEntries(results, tenantId, userId) {
  const { generateAdvanceEntry } = require('../accounting/autoEntries.service');
  const logger = require('../../config/logger');
  for (const { advance, accounted } of results) {
    if (accounted) continue;
    try {
      await generateAdvanceEntry(advance, tenantId, userId);
    } catch (err) {
      logger.warn(`[accounting] Error generando asiento de anticipo ${advance.id} (desde OT): ${err.message}`);
    }
  }
}

module.exports = { round2, transferableAmount, accountedPaymentIds, moveToAdvances, generateMovedAdvanceEntries };
