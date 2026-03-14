// backend/src/controllers/sales/voidSale.js
//
// POST /api/sales/:id/void
//
// Flujo:
//   1. Valida venta e ítems
//   2. Crea CustomerReturn + aprueba (inventario devuelto en la misma transacción)
//   3. Si hay OT vinculada → la marca como 'cancelado' (query separada, no bloquea)
//   4. Si es factura → nota crédito DIAN async

'use strict';

const { sequelize }  = require('../../config/database');
const {
  Sale, SaleItem, Product,
  CustomerReturn, CustomerReturnItem,
  WorkOrder,
} = require('../../models');
const { createMovement } = require('../inventory/movements.controller');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const logger = require('../../config/logger');

// ── Número DEV único con advisory lock ───────────────────────────────────────
async function generateReturnNumber(tenant_id, transaction) {
  const year   = new Date().getFullYear();
  const prefix = `DEV-${year}-`;

  await sequelize.query(
    `SELECT pg_advisory_xact_lock(
       ('x' || substr(md5(:lock_key), 1, 16))::bit(64)::bigint
     )`,
    { replacements: { lock_key: `customer_return_${tenant_id}` }, transaction }
  );

  const [result] = await sequelize.query(
    `SELECT MAX(CAST(SPLIT_PART(return_number, '-', 3) AS INTEGER)) AS max_num
     FROM customer_returns WHERE return_number LIKE :prefix`,
    { replacements: { prefix: `${prefix}%` }, type: sequelize.QueryTypes.SELECT, transaction }
  );

  const next = (result?.max_num != null ? parseInt(result.max_num, 10) : 0) + 1;
  return `${prefix}${String(next).padStart(5, '0')}`;
}

// ── Controller ────────────────────────────────────────────────────────────────
const voidSale = async (req, res) => {
  const { id }    = req.params;
  const tenant_id = req.tenant_id;
  const user_id   = req.user_id || req.user?.id;
  const { items, reason, notes, return_type = 'total' } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ success: false, message: 'Debe indicar al menos un ítem a devolver' });
  if (!reason)
    return res.status(400).json({ success: false, message: 'El motivo es obligatorio' });

  const transaction = await sequelize.transaction();

  try {
    // ── 1. Cargar venta con ítems (sin WorkOrder en la transacción) ───────────
    const sale = await Sale.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: SaleItem,
          as: 'items',
          include: [{ model: Product, as: 'product' }],
        },
      ],
      transaction,
    });

    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Venta no encontrada' });
    }
    if (['draft', 'cancelled'].includes(sale.status)) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: sale.status === 'draft'
          ? 'No se puede anular un borrador — cancélalo directamente'
          : 'Esta venta ya está cancelada',
      });
    }

    // ── 2. Validar ítems ──────────────────────────────────────────────────────
    let subtotal = 0;
    let tax      = 0;
    const validatedItems = [];

    for (const reqItem of items) {
      const saleItem = sale.items.find(si => si.id === reqItem.sale_item_id);
      if (!saleItem) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `Ítem ${reqItem.sale_item_id} no pertenece a esta venta` });
      }

      const qtyReq = parseFloat(reqItem.quantity);
      if (!qtyReq || qtyReq <= 0) continue;

      if (qtyReq > parseFloat(saleItem.quantity)) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `${saleItem.product_name}: máximo ${saleItem.quantity} unidades`,
        });
      }

      const alreadyReturned = (await CustomerReturnItem.sum('quantity', {
        where: { sale_item_id: saleItem.id },
        transaction,
      })) || 0;

      const remaining = parseFloat(saleItem.quantity) - parseFloat(alreadyReturned);
      if (qtyReq > remaining) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `${saleItem.product_name}: solo quedan ${remaining} unidades por devolver`,
        });
      }

      const ratio      = qtyReq / parseFloat(saleItem.quantity);
      const itemSubtot = parseFloat(saleItem.subtotal || 0) * ratio;
      const itemTax    = parseFloat(saleItem.tax_amount || 0) * ratio;

      subtotal += itemSubtot;
      tax      += itemTax;

      validatedItems.push({
        sale_item_id: saleItem.id,
        product_id:   saleItem.product_id,
        quantity:     qtyReq,
        unit_price:   parseFloat(saleItem.unit_price),
        unit_cost:    parseFloat(saleItem.unit_cost || saleItem.product?.average_cost || saleItem.unit_price || 0),
        condition:    reqItem.condition || 'used',
        destination:  reqItem.condition === 'defective' ? 'quarantine' : 'inventory',
        subtotal:     itemSubtot,
        tax:          itemTax,
        total:        itemSubtot + itemTax,
        _saleItem:    saleItem,
        _product:     saleItem.product,
      });
    }

    if (validatedItems.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay ítems válidos para devolver' });
    }

    // ── 3. Crear CustomerReturn ───────────────────────────────────────────────
    const return_number = await generateReturnNumber(tenant_id, transaction);

    const customerReturn = await CustomerReturn.create({
      tenant_id,
      return_number,
      sale_id:      sale.id,
      customer_id:  sale.customer_id,
      return_date:  new Date(),
      reason,
      notes:        notes || null,
      subtotal,
      tax,
      total_amount: subtotal + tax,
      status:       'approved',
      created_by:   user_id,
      approved_by:  user_id,
      approved_at:  new Date(),
    }, { transaction });

    // ── 4. Ítems + movimientos de inventario ──────────────────────────────────
    for (const item of validatedItems) {
      await CustomerReturnItem.create({
        return_id:    customerReturn.id,
        sale_item_id: item.sale_item_id,
        product_id:   item.product_id,
        quantity:     item.quantity,
        unit_price:   item.unit_price,
        unit_cost:    item.unit_cost,
        condition:    item.condition,
        destination:  item.destination,
        subtotal:     item.subtotal,
        tax:          item.tax,
        total:        item.total,
      }, { transaction });

      const product = item._product;
      if (product && product.track_inventory && item.destination === 'inventory') {
        await createMovement({
          tenant_id,
          movement_type:   'entrada',
          movement_reason: 'customer_return',
          product_id:      item.product_id,
          warehouse_id:    sale.warehouse_id || null,
          quantity:        item.quantity,
          unit_cost:       item.unit_cost,
          reference_type:  'customer_return',
          reference_id:    customerReturn.id,
          user_id,
          notes: `Devolución ${return_number} — ${sale.sale_number}`,
        }, transaction);

        const updatedProd = await Product.findByPk(item.product_id, { transaction });
        if (updatedProd) {
          await updatedProd.update({
            available_stock: parseFloat(updatedProd.current_stock) - parseFloat(updatedProd.reserved_stock || 0),
          }, { transaction });
        }
      }
    }

    // ── 5. Commit ─────────────────────────────────────────────────────────────
    await transaction.commit();

    // ── 6. Actualizar OT vinculada (fuera de transacción, no bloquea) ─────────
    let workOrderUpdated = null;
    try {
      const workOrder = await WorkOrder.findOne({
        where: { sale_id: sale.id },
        attributes: ['id', 'work_order_number', 'status', 'notes'],
      });

      if (workOrder && !['cancelado', 'entregado'].includes(workOrder.status)) {
        const newNotes = [
          workOrder.notes,
          `Venta ${sale.sale_number} anulada — devolución ${return_number}`,
        ].filter(Boolean).join(' | ');

        await workOrder.update({ status: 'cancelado', notes: newNotes });

        workOrderUpdated = {
          id:                workOrder.id,
          work_order_number: workOrder.work_order_number,
          previous_status:   workOrder.status,
          new_status:        'cancelado',
        };
      }
    } catch (woErr) {
      // No crítico: la devolución ya fue guardada, solo loguear
      logger.warn('[VOID] No se pudo actualizar OT:', woErr.message);
    }

    // ── 7. Nota crédito DIAN (async) ──────────────────────────────────────────
    let dian_status = 'not_applicable';

    if (sale.document_type === 'factura') {
      dian_status = 'pending';
      setImmediate(async () => {
        try {
          const { dianService } = require('../../services/dian/dianService');
          const { Tenant }      = require('../../models');
          const tenant          = await Tenant.findByPk(tenant_id);

          const creditNotePayload = {
            id:               customerReturn.id,
            sale_number:      return_number,
            document_type:    'nota_credito',
            customer_id:      sale.customer_id,
            customer_name:    sale.customer_name,
            customer_tax_id:  sale.customer_tax_id,
            customer_email:   sale.customer_email,
            customer_address: sale.customer_address,
            sale_date:        new Date(),
            subtotal,
            tax_amount:       tax,
            total_amount:     subtotal + tax,
            discount_amount:  0,
            payment_method:   sale.payment_method,
            notes:            `Nota crédito por devolución ${return_number}. Ref: ${sale.sale_number}`,
            billing_reference: {
              sale_number: sale.sale_number,
              sale_date:   sale.sale_date,
              cufe:        sale.cufe || sale.uuid,
            },
            items: validatedItems.map(item => ({
              product_id:          item.product_id,
              product_name:        item._saleItem.product_name,
              product_sku:         item._saleItem.product_sku,
              quantity:            item.quantity,
              unit_price:          item.unit_price,
              discount_amount:     0,
              discount_percentage: 0,
              tax_percentage:      item._saleItem.tax_percentage || 0,
              tax_amount:          item.tax,
              subtotal:            item.subtotal,
              total:               item.total,
            })),
            tenant_id,
          };

          await dianService.sendCreditNoteToDian(creditNotePayload, tenant);
          logger.info(`[VOID] Nota crédito ${return_number} enviada a DIAN`);
        } catch (err) {
          logger.error(`[VOID] Error enviando nota crédito ${return_number} a DIAN:`, err.message);
        }
      });
    }

    // ── 8. Alertas de stock ───────────────────────────────────────────────────
    const product_ids = validatedItems.map(i => i.product_id).filter(Boolean);
    markProductsForAlertCheck(res, product_ids, tenant_id);

    return res.status(201).json({
      success: true,
      message: sale.document_type === 'factura'
        ? 'Devolución registrada. Nota crédito en proceso de envío a DIAN.'
        : 'Devolución registrada e inventario ajustado exitosamente.',
      data: {
        return_number,
        return_id:          customerReturn.id,
        total_amount:       subtotal + tax,
        items_count:        validatedItems.length,
        dian_status,
        document_type:      sale.document_type,
        work_order_updated: workOrderUpdated,
      },
    });

  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback().catch(() => {});
    }
    logger.error('[VOID] Error en voidSale:', error);
    return res.status(500).json({ success: false, message: 'Error al procesar la anulación: ' + error.message });
  }
};

module.exports = voidSale;