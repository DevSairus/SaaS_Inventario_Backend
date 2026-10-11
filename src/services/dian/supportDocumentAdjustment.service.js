// backend/src/services/dian/supportDocumentAdjustment.service.js
//
// Nota de Ajuste al Documento Soporte (tipo DIAN 95). Extraído de
// dian.controller.js#createSupportDocumentAdjustment para emitirla también al
// aprobar una devolución a proveedor de una compra con Documento Soporte
// aceptado (supplierReturns.controller.js). Es solo documento fiscal: no
// genera asiento (la devolución hace inventario, CxP y contabilidad).

const { Tenant } = require('../../models');
const dianService = require('./dianService');
const dianKit = require('./dianKitAdapter');
const logger = require('../../config/logger');

const httpError = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/**
 * @param {object} p - { tenantId, supportDocumentId, adjustment_type, reason, items?, amount?, userId }
 * @returns {Promise<object>} SupportDocumentAdjustment (el envío a DIAN sigue en segundo plano)
 */
async function createSupportDocumentAdjustment({ tenantId, supportDocumentId, adjustment_type, reason, items, amount, userId }) {
  const { sequelize: seq } = require('../../config/database');
  const { SupportDocument, SupportDocumentAdjustment, Purchase, PurchaseItem, Supplier, Expense } = require('../../models');
  const transaction = await seq.transaction();
  try {

    if (!['credit', 'debit'].includes(adjustment_type)) {
      throw httpError("adjustment_type debe ser 'credit' o 'debit'");
    }
    if (!reason) {
      throw httpError('El motivo es obligatorio');
    }

    const supportDocument = await SupportDocument.findOne({
      where: { id: supportDocumentId, tenant_id: tenantId },
      include: [
        { model: Purchase, as: 'purchase', include: [{ model: Supplier, as: 'supplier' }] },
        { model: Expense, as: 'expense', include: [{ model: Supplier, as: 'supplier' }] },
      ],
      transaction,
    });
    if (!supportDocument) throw httpError('Documento Soporte no encontrado', 404);
    if (supportDocument.dian_status !== 'accepted' || !supportDocument.cuds) {
      throw httpError('El Documento Soporte debe estar aceptado por la DIAN antes de generar una Nota de Ajuste.');
    }

    const source = supportDocument.source_type === 'purchase' ? supportDocument.purchase : supportDocument.expense;
    const supplier = source?.supplier;
    if (!supplier && !supportDocument.seller_snapshot) {
      throw httpError('Esta Nota de Ajuste no se puede generar: el Documento Soporte original no tiene un proveedor real asociado ni datos de vendedor guardados. Vincula un proveedor primero.');
    }

    // Calcular ítems de la nota de ajuste — mismo criterio que createAndSendDebitNote
    const noteItems = [];
    let noteSubtotal = 0;
    let noteTax = 0;

    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        const qty = parseFloat(item.quantity) || 1;
        const price = parseFloat(item.unit_price) || 0;
        const taxPct = parseFloat(item.tax_percentage) || 0;
        const subtot = qty * price;
        const tax = subtot * taxPct / 100;

        noteSubtotal += subtot;
        noteTax += tax;
        noteItems.push({
          id: String(noteItems.length + 1),
          description: item.description || 'Ajuste',
          quantity: qty,
          unit_code: 'EA',
          unit_price: price,
          subtotal: subtot,
          tax_amount: tax,
          tax_rate: taxPct,
        });
      }
    } else if (amount && parseFloat(amount) > 0) {
      const amt = parseFloat(amount);
      noteSubtotal = amt;
      noteItems.push({
        id: '1',
        description: reason || 'Ajuste al Documento Soporte',
        quantity: 1,
        unit_code: 'EA',
        unit_price: amt,
        subtotal: amt,
        tax_amount: 0,
        tax_rate: 0,
      });
    } else {
      throw httpError('Debe especificar ítems o un monto para la Nota de Ajuste');
    }

    const noteTotal = noteSubtotal + noteTax;

    const adjustment = await SupportDocumentAdjustment.create({
      tenant_id: tenantId,
      support_document_id: supportDocument.id,
      adjustment_type,
      reason,
      items: noteItems,
      subtotal: noteSubtotal,
      tax_amount: noteTax,
      total_amount: noteTotal,
      dian_status: 'pending',
      created_by: userId,
    }, { transaction });

    await transaction.commit();

    const tenant = await Tenant.findByPk(tenantId);
    // Prioriza el proveedor real vigente (datos más al día que el snapshot
    // si el proveedor se editó desde el envío original) -- el snapshot es
    // solo el fallback para cuando no hay Supplier vinculado (vendedor
    // ad-hoc, ver nota de Fase 5 arriba).
    const seller = supplier ? dianKit.buildSellerFromSupplier(supplier) : supportDocument.seller_snapshot;
    const retentions = {
      retefuente_rate: source.retefuente_rate, retefuente_amount: source.retefuente_amount,
      reteiva_rate: source.reteiva_rate, reteiva_amount: source.reteiva_amount,
      reteica_rate: source.reteica_rate, reteica_amount: source.reteica_amount,
    };

    setImmediate(async () => {
      try {
        await dianService.sendSupportDocumentAdjustmentToDian(adjustment, supportDocument, seller, tenant, retentions);
        logger.info(`[DIAN] Nota de Ajuste creada para Documento Soporte ${supportDocument.id}`);
      } catch (err) {
        logger.error(`[DIAN] Error enviando Nota de Ajuste de ${supportDocument.id}:`, err.message);
      }
    });

    return adjustment;
  } catch (e) {
    if (transaction && !transaction.finished) await transaction.rollback();
    throw e;
  }
}

module.exports = { createSupportDocumentAdjustment };
