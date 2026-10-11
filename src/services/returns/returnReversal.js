// backend/src/services/returns/returnReversal.js
//
// Reversar una devolución APROBADA (aprobada por error, el cliente se queda
// finalmente con la mercancía, etc.). Deshace todo lo que hizo la aprobación,
// con movimientos NUEVOS -- no se reescribe el pasado (kardex, cuadre de caja
// y contabilidad conservan el original y su reversión):
//
//  - Inventario: lo que volvió a stock vuelve a salir (cliente) o a entrar
//    (proveedor).
//  - Cartera / CxP: se devuelve returned_amount de la venta / compra.
//  - Saldo a favor: el del cliente (anticipo) se anula si no se ha usado;
//    el del proveedor se desaplica de las compras donde se usó.
//  - Dinero: si se devolvió dinero, el movimiento inverso pasa por la caja
//    abierta o una cuenta bancaria (reversal_*).
//  - Contabilidad: asiento espejo del de la devolución (reverseEntry).
//
// No se puede reversar si ya hay un documento ante la DIAN (nota crédito o
// Nota de Ajuste no rechazada): eso no se deshace; se factura de nuevo.

'use strict';

const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const badRequest = (message) => { const err = new Error(message); err.status = 400; return err; };

async function assertReversalAllowedByDian({ creditNoteSaleId, supportAdjustmentId, tenantId, transaction }) {
  const { Sale, SupportDocumentAdjustment } = require('../../models');
  if (creditNoteSaleId) {
    const note = await Sale.findOne({ where: { id: creditNoteSaleId, tenant_id: tenantId }, attributes: ['dian_status'], transaction });
    if (note && note.dian_status !== 'rejected') {
      throw badRequest('La devolución ya tiene nota crédito electrónica ante la DIAN: no se puede reversar. Si el cliente se queda con la mercancía, factúrala de nuevo.');
    }
  }
  if (supportAdjustmentId) {
    const adj = await SupportDocumentAdjustment.findOne({ where: { id: supportAdjustmentId, tenant_id: tenantId }, attributes: ['dian_status'], transaction });
    if (adj && adj.dian_status !== 'rejected') {
      throw badRequest('La devolución ya tiene Nota de Ajuste al Documento Soporte ante la DIAN: no se puede reversar.');
    }
  }
}

// Movimiento de dinero que deshace el de la devolución. `direction`: 'in'
// (entra a la caja: el cliente nos devuelve lo reintegrado) u 'out' (sale:
// le devolvemos al proveedor lo que nos reintegró).
async function reversalMoneyFields({ amount, direction, body, tenantId, branchId, transaction }) {
  if (!(amount > 0)) return {};
  const { getOpenSession, isTreasuryEnabled, assertCashAvailable } = require('../finance/cashSession.service');
  const { resolveSelectedBankAccountId } = require('../accounting/bankAccountSelection');
  let openSession = null;
  if (await isTreasuryEnabled(tenantId)) {
    openSession = await getOpenSession(tenantId, branchId, transaction);
    if (!openSession) throw badRequest('No hay una caja abierta en esta sede. Abre la caja antes de reversar la devolución.');
  }
  const method = body.payment_method || 'Efectivo';
  if (direction === 'out') await assertCashAvailable(openSession, amount, method);
  return {
    reversal_amount: amount,
    reversal_method: method,
    reversal_bank_account_id: await resolveSelectedBankAccountId(tenantId, body.bank_account_id, method, transaction),
    reversal_cash_session_id: openSession?.id || null,
    reversal_branch_id: branchId || null,
  };
}

async function reverseReturnEntry(sourceType, sourceId, tenantId, userId, reason, transaction) {
  const { JournalEntry } = require('../../models');
  const { reverseEntry } = require('../accounting/journalEntry.service');
  const entry = await JournalEntry.findOne({
    where: { tenant_id: tenantId, source_type: sourceType, source_id: sourceId, status: { [Op.ne]: 'voided' }, reversed_by_entry_id: null },
    transaction,
  });
  if (!entry) return null;
  const result = await reverseEntry(entry.id, tenantId, userId, reason, transaction);
  return result?.reversalEntry?.id || result?.entry?.id || null;
}

/**
 * @param {object} p - { id, tenantId, userId, branchId, body: { reason, payment_method, bank_account_id } }
 */
async function reverseCustomerReturn({ id, tenantId, userId, branchId, body = {} }) {
  const { CustomerReturn, CustomerReturnItem, CustomerAdvance, Sale, Product } = require('../../models');
  const { salePaymentStatus } = require('../../utils/saleAmounts');
  const { assertPeriodOpen } = require('../accounting/journalEntry.service');
  const { createMovement } = require('../../controllers/inventory/movements.controller');
  if (!String(body.reason || '').trim()) throw badRequest('Indica el motivo de la reversión.');

  const transaction = await sequelize.transaction();
  try {
    const customerReturn = await CustomerReturn.findOne({ where: { id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!customerReturn) { const e = badRequest('Devolución no encontrada'); e.status = 404; throw e; }
    if (customerReturn.status !== 'approved') throw badRequest('Solo se pueden reversar devoluciones aprobadas.');
    await assertPeriodOpen(tenantId, new Date(), transaction);
    await assertReversalAllowedByDian({ creditNoteSaleId: customerReturn.credit_note_sale_id, tenantId, transaction });

    const items = await CustomerReturnItem.findAll({
      where: { return_id: customerReturn.id },
      include: [{ model: Product, as: 'product' }],
      transaction,
    });
    const sale = await Sale.findOne({ where: { id: customerReturn.sale_id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });

    // Saldo a favor: solo si no se ha tocado (aplicado, devuelto o reasignado).
    if (customerReturn.settlement_type === 'credit' && customerReturn.credit_advance_id) {
      const advance = await CustomerAdvance.findOne({ where: { id: customerReturn.credit_advance_id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
      if (advance && advance.status !== 'voided') {
        const touched = Number(advance.applied_amount || 0) > 0 || Number(advance.refunded_amount || 0) > 0 || Number(advance.reassigned_amount || 0) > 0;
        if (touched) {
          throw badRequest(`El saldo a favor ${advance.advance_number} ya se usó (aplicado, devuelto o reasignado): revierte primero ese uso.`);
        }
        await advance.update({
          status: 'voided', balance: 0, voided_at: new Date(), voided_by: userId,
          voided_reason: `Reversión de la devolución ${customerReturn.return_number}`,
        }, { transaction });
      }
    }

    // Inventario: lo que volvió a stock vuelve a salir.
    for (const item of items) {
      if (!item.product?.track_inventory || item.destination !== 'inventory') continue;
      await createMovement({
        tenant_id: tenantId,
        movement_type: 'salida',
        movement_reason: 'customer_return_reversal',
        product_id: item.product_id,
        warehouse_id: sale?.warehouse_id || null,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        reference_type: 'customer_return',
        reference_id: customerReturn.id,
        user_id: userId,
        notes: `Reversión de la devolución ${customerReturn.return_number}`,
      }, transaction);
      const updated = await Product.findByPk(item.product_id, { transaction });
      if (updated) {
        await updated.update({ available_stock: parseFloat(updated.current_stock) - parseFloat(updated.reserved_stock || 0) }, { transaction });
      }
    }

    // Cartera.
    const reduction = Number(customerReturn.receivable_reduction || 0);
    if (sale && reduction > 0) {
      sale.returned_amount = round2(Math.max(Number(sale.returned_amount || 0) - reduction, 0));
      await sale.update({ returned_amount: sale.returned_amount, payment_status: salePaymentStatus(sale) }, { transaction });
    }

    // Dinero reintegrado: el cliente lo devuelve (entra a caja/banco).
    const money = customerReturn.settlement_type === 'refund'
      ? await reversalMoneyFields({ amount: Number(customerReturn.refund_amount || 0), direction: 'in', body, tenantId, branchId, transaction })
      : {};

    const reason = String(body.reason).trim();
    const reversalEntryId = await reverseReturnEntry('customer_return', customerReturn.id, tenantId, userId, `Reversión de la devolución ${customerReturn.return_number}: ${reason}`, transaction);

    await customerReturn.update({
      status: 'reversed',
      reversed_by: userId,
      reversed_at: new Date(),
      reversal_reason: reason,
      reversal_entry_id: reversalEntryId,
      ...money,
    }, { transaction });

    await transaction.commit();
    return { customerReturn, productIds: items.map((i) => i.product_id) };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
}

/**
 * @param {object} p - { id, tenantId, userId, branchId, body: { reason, payment_method, bank_account_id } }
 */
async function reverseSupplierReturn({ id, tenantId, userId, branchId, body = {} }) {
  const { SupplierReturn, SupplierReturnItem, Purchase, Product } = require('../../models');
  const { purchasePaymentStatus } = require('../../utils/purchaseAmounts');
  const { assertPeriodOpen } = require('../accounting/journalEntry.service');
  const { createMovement } = require('../../controllers/inventory/movements.controller');
  if (!String(body.reason || '').trim()) throw badRequest('Indica el motivo de la reversión.');

  const transaction = await sequelize.transaction();
  try {
    const supplierReturn = await SupplierReturn.findOne({ where: { id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
    if (!supplierReturn) { const e = badRequest('Devolución no encontrada'); e.status = 404; throw e; }
    if (supplierReturn.status !== 'approved') throw badRequest('Solo se pueden reversar devoluciones aprobadas.');
    await assertPeriodOpen(tenantId, new Date(), transaction);
    await assertReversalAllowedByDian({ supportAdjustmentId: supplierReturn.support_adjustment_id, tenantId, transaction });

    const items = await SupplierReturnItem.findAll({
      where: { return_id: supplierReturn.id },
      include: [{ model: Product, as: 'product' }],
      transaction,
    });

    // Inventario: lo que salió hacia el proveedor vuelve a entrar.
    for (const item of items) {
      if (!item.product) continue;
      await createMovement({
        tenant_id: tenantId,
        movement_type: 'entrada',
        movement_reason: 'supplier_return_reversal',
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        reference_type: 'supplier_return',
        reference_id: supplierReturn.id,
        user_id: userId,
        notes: `Reversión de la devolución a proveedor ${supplierReturn.return_number}`,
      }, transaction);
      const updated = await Product.findByPk(item.product_id, { transaction });
      if (updated) {
        await updated.update({ available_stock: parseFloat(updated.current_stock) - parseFloat(updated.reserved_stock || 0) }, { transaction });
      }
    }

    // CxP de la compra devuelta.
    const purchase = await Purchase.findOne({ where: { id: supplierReturn.purchase_id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
    const reduction = Number(supplierReturn.payable_reduction || 0);
    if (purchase && reduction > 0) {
      purchase.returned_amount = round2(Math.max(Number(purchase.returned_amount || 0) - reduction, 0));
      await purchase.update({ returned_amount: purchase.returned_amount, payment_status: purchasePaymentStatus(purchase) }, { transaction });
    }

    // Saldo a favor aplicado a otras compras: se desaplica (vuelven a deberse).
    const touchedPurchaseIds = new Set(purchase ? [purchase.id] : []);
    if (supplierReturn.settlement_type === 'credit') {
      for (const app of supplierReturn.credit_applications || []) {
        const target = await Purchase.findOne({ where: { id: app.purchase_id, tenant_id: tenantId }, lock: transaction.LOCK.UPDATE, transaction });
        if (!target) continue;
        const history = target.payment_history || [];
        const removed = history.filter((p) => p.source === 'supplier_credit' && p.supplier_return_id === supplierReturn.id);
        if (!removed.length) continue;
        const removedAmount = removed.reduce((acc, p) => acc + Number(p.amount || 0), 0);
        const paid_amount = round2(Math.max(Number(target.paid_amount || 0) - removedAmount, 0));
        await target.update({
          paid_amount,
          payment_status: purchasePaymentStatus(target, paid_amount),
          payment_history: history.filter((p) => !(p.source === 'supplier_credit' && p.supplier_return_id === supplierReturn.id)),
        }, { transaction });
        touchedPurchaseIds.add(target.id);
      }
    }

    // Reintegro recibido del proveedor: se le devuelve (sale de caja/banco).
    const money = supplierReturn.settlement_type === 'refund'
      ? await reversalMoneyFields({ amount: Number(supplierReturn.refund_amount || 0), direction: 'out', body, tenantId, branchId, transaction })
      : {};

    const reason = String(body.reason).trim();
    const reversalEntryId = await reverseReturnEntry('supplier_return', supplierReturn.id, tenantId, userId, `Reversión de la devolución a proveedor ${supplierReturn.return_number}: ${reason}`, transaction);

    await supplierReturn.update({
      status: 'reversed',
      reversed_by: userId,
      reversed_at: new Date(),
      reversal_reason: reason,
      reversal_entry_id: reversalEntryId,
      credit_applied_amount: supplierReturn.settlement_type === 'credit' ? 0 : supplierReturn.credit_applied_amount,
      ...money,
    }, { transaction });

    await transaction.commit();
    return { supplierReturn, productIds: items.map((i) => i.product_id), purchaseIds: [...touchedPurchaseIds] };
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    throw error;
  }
}

module.exports = { reverseCustomerReturn, reverseSupplierReturn };
