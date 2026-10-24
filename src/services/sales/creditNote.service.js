// backend/src/services/sales/creditNote.service.js
//
// Crea una nota crédito (Sale document_type 'nota_credito') sobre una factura
// electrónica aceptada y la envía a la DIAN. Extraído de
// dian.controller.js#createAndSendCreditNote para reutilizarlo al aprobar
// una devolución de cliente sobre una factura electrónica
// (customerReturns.controller.js): ahí la nota es SOLO el documento fiscal --
// inventario, cartera y el asiento (reversión de ingreso/IVA) los hace la
// devolución, por eso `skipAccounting` evita duplicar la reversión.

const { Tenant, Sale, SaleItem } = require('../../models');
const dianService = require('../dian/dianService');
const logger = require('../../config/logger');
const { pickComboFields } = require('../../utils/comboLines');

const httpError = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.saleId - factura original
 * @param {Array}  [p.items] - [{ sale_item_id, quantity }] (por ítems)
 * @param {number} [p.amount] - monto fijo (sin items)
 * @param {string} p.reason
 * @param {string} p.userId
 * @param {boolean} [p.skipAccounting=false]
 * @returns {{ noteSale, noteItems, original }} -- el envío a la DIAN sigue en segundo plano
 */
async function createAndSendCreditNote({ tenantId, saleId, items, amount, reason, userId, skipAccounting = false }) {
  const { sequelize: seq } = require('../../config/database');
  const transaction = await seq.transaction();
  try {

    if (!reason) {
      throw httpError('El motivo es obligatorio');
    }

    // Cargar factura original
    const original = await Sale.findOne({
      where: { id: saleId, tenant_id: tenantId, document_type: 'factura' },
      include: [{ model: SaleItem, as: 'items' }],
      transaction,
    });
    if (!original) throw httpError('Factura no encontrada', 404);
    // Factura que agrupa remisiones: la venta real está en las remisiones;
    // una nota manual acá movería contabilidad que esta factura no tiene.
    // Se anula con su propia acción (POST /sales/:id/annul-consolidated).
    if (original.is_consolidated_invoice) {
      throw httpError('Esta factura agrupa remisiones: anúlala con "Anular factura agrupada" desde el detalle de la venta.');
    }
    if (!original.cufe) {
      throw httpError('La factura no tiene CUFE. Debe ser aceptada por la DIAN primero.');
    }
    if (!original.items?.length) {
      throw httpError('La factura no tiene ítems');
    }

    // Calcular ítems de la nota crédito
    const noteItems = [];
    let noteSubtotal = 0;
    let noteTax = 0;

    if (items && Array.isArray(items) && items.length > 0) {
      // ── Modo: por ítems seleccionados ──
      for (const reqItem of items) {
        const saleItem = original.items.find(i => i.id === reqItem.sale_item_id);
        if (!saleItem) throw httpError(`Ítem ${reqItem.sale_item_id} no pertenece a esta factura`);

        const qtyReq = parseFloat(reqItem.quantity);
        if (!qtyReq || qtyReq <= 0) continue;
        if (qtyReq > parseFloat(saleItem.quantity)) {
          throw httpError(`${saleItem.product_name}: máximo ${saleItem.quantity} unidades`);
        }

        const ratio = qtyReq / parseFloat(saleItem.quantity);
        const itemSubtot = parseFloat(saleItem.subtotal || 0) * ratio;
        const itemTax = parseFloat(saleItem.tax_amount || 0) * ratio;
        // El INC (impoconsumo) de la línea también se acredita en proporción:
        // antes la nota solo devolvía el IVA y quedaba por debajo de lo facturado.
        const itemInc = parseFloat(saleItem.inc_amount || 0) * ratio;

        noteSubtotal += itemSubtot;
        noteTax += itemTax + itemInc; // tax_amount del documento = IVA + INC, como en la venta
        noteItems.push({
          item_type: saleItem.item_type || 'product',
          product_name: saleItem.product_name,
          product_sku: saleItem.product_sku,
          product_id: saleItem.product_id,
          quantity: qtyReq,
          unit_price: parseFloat(saleItem.unit_price),
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: parseFloat(saleItem.tax_percentage || 0),
          iva_status: saleItem.iva_status || null,
          tax_amount: itemTax,
          inc_rate: parseFloat(saleItem.inc_rate || 0),
          inc_amount: itemInc,
          subtotal: itemSubtot,
          total: itemSubtot + itemTax + itemInc,
          ...pickComboFields(saleItem),
          _source_item_id: saleItem.id,
          _full_quantity: qtyReq === parseFloat(saleItem.quantity),
        });
      }
      // Un combo "solo nombre y total" se acredita resumido solo si entra
      // completo (todas sus líneas, cantidades totales); si no, la nota
      // muestra los componentes acreditados.
      for (const noteItem of noteItems) {
        if (!noteItem.combo_group_id || noteItem.combo_show_breakdown) continue;
        const groupLines = original.items.filter(i => i.combo_group_id === noteItem.combo_group_id);
        const complete = groupLines.every(gl => noteItems.some(n => n._source_item_id === gl.id && n._full_quantity));
        if (!complete) noteItem.combo_show_breakdown = true;
      }
    } else if (amount && parseFloat(amount) > 0) {
      // ── Modo: monto fijo — distribuir proporcionalmente ──
      const targetAmount = Math.min(parseFloat(amount), parseFloat(original.total_amount));
      const totalRatio = targetAmount / parseFloat(original.total_amount);

      for (const si of original.items) {
        const itemSubtot = parseFloat(si.subtotal || 0) * totalRatio;
        const itemTax = parseFloat(si.tax_amount || 0) * totalRatio;
        const itemInc = parseFloat(si.inc_amount || 0) * totalRatio;
        const qty = parseFloat(si.quantity) * totalRatio;

        noteSubtotal += itemSubtot;
        noteTax += itemTax + itemInc;
        noteItems.push({
          item_type: si.item_type || 'product',
          product_name: si.product_name,
          product_sku: si.product_sku,
          product_id: si.product_id,
          quantity: Math.round(qty * 100) / 100,
          unit_price: parseFloat(si.unit_price),
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: parseFloat(si.tax_percentage || 0),
          iva_status: si.iva_status || null,
          tax_amount: itemTax,
          inc_rate: parseFloat(si.inc_rate || 0),
          inc_amount: itemInc,
          subtotal: itemSubtot,
          total: itemSubtot + itemTax + itemInc,
          ...pickComboFields(si),
        });
      }
    } else {
      // ── Modo: devolución total ──
      for (const si of original.items) {
        const itemSubtot = parseFloat(si.subtotal || 0);
        const itemTax = parseFloat(si.tax_amount || 0);
        const itemInc = parseFloat(si.inc_amount || 0);

        noteSubtotal += itemSubtot;
        noteTax += itemTax + itemInc;
        noteItems.push({
          item_type: si.item_type || 'product',
          product_name: si.product_name,
          product_sku: si.product_sku,
          product_id: si.product_id,
          quantity: parseFloat(si.quantity),
          unit_price: parseFloat(si.unit_price),
          discount_amount: 0,
          discount_percentage: 0,
          tax_percentage: parseFloat(si.tax_percentage || 0),
          iva_status: si.iva_status || null,
          tax_amount: itemTax,
          inc_rate: parseFloat(si.inc_rate || 0),
          inc_amount: itemInc,
          subtotal: itemSubtot,
          total: itemSubtot + itemTax + itemInc,
          ...pickComboFields(si),
        });
      }
    }

    if (noteItems.length === 0) {
      throw httpError('No hay ítems válidos para la nota crédito');
    }

    // Factura AIU: A, I, U y el IVA (que va solo sobre la U) se acreditan
    // en proporción al costo directo acreditado -- ver aiu.service.js#prorateAiu.
    let aiuNote = null;
    if (original.aiu_enabled) {
      const { prorateAiu } = require('./aiu.service');
      aiuNote = prorateAiu(original, noteSubtotal);
      noteSubtotal = aiuNote.subtotal;
      noteTax = aiuNote.tax;
    }

    // Parte del descuento global de la factura que le toca a lo acreditado
    // (services/sales/globalDiscount.service.js): la NC va por el NETO, con
    // el descuento como AllowanceCharge de documento -- igual que la factura.
    // Antes acreditaba el valor de lista y superaba lo cobrado.
    const { discountShare, round2 } = require('./globalDiscount.service');
    const noteDiscount = discountShare(original, noteSubtotal + noteTax);
    const noteTotal = round2(noteSubtotal + noteTax - noteDiscount);
    const noteNumber = `NC-${Date.now()}`;

    // Crear Sale como nota crédito
    const noteSale = await Sale.create({
      tenant_id: tenantId,
      branch_id: original.branch_id,
      reference_sale_id: original.id,
      sale_number: noteNumber,
      document_type: 'nota_credito',
      sale_date: new Date(),
      customer_id: original.customer_id,
      customer_name: original.customer_name,
      customer_tax_id: original.customer_tax_id,
      customer_email: original.customer_email,
      customer_phone: original.customer_phone,
      customer_address: original.customer_address,
      customer_city_code: original.customer_city_code,
      customer_city_name: original.customer_city_name,
      customer_department_name: original.customer_department_name,
      customer_document_type: original.customer_document_type,
      subtotal: noteSubtotal,
      tax_amount: noteTax,
      discount_amount: 0,
      global_discount_amount: noteDiscount,
      total_amount: noteTotal,
      payment_method: original.payment_method,
      payment_status: 'paid',
      paid_amount: noteTotal,
      status: 'completed',
      notes: `Nota crédito para factura ${original.dian_invoice_number || original.sale_number}. Motivo: ${reason}`,
      dian_status: 'pending',
      ...(aiuNote ? aiuNote.fields : {}),
    }, { transaction });

    // Crear ítems de la nota crédito
    for (const item of noteItems) {
      await SaleItem.create({
        sale_id: noteSale.id,
        tenant_id: tenantId,
        item_type: item.item_type || 'product',
        product_id: item.product_id,
        product_name: item.product_name,
        product_sku: item.product_sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        discount_percentage: 0,
        discount_amount: 0,
        tax_percentage: item.tax_percentage,
        tax_amount: item.tax_amount,
        iva_status: item.iva_status || null,
        inc_rate: item.inc_rate || 0,
        inc_amount: item.inc_amount || 0,
        subtotal: item.subtotal,
        total: item.total,
        unit_cost: 0,
        ...pickComboFields(item),
      }, { transaction });
    }

    await transaction.commit();

    // Asiento contable en borrador (no bloqueante: si falla, solo se loguea).
    if (!skipAccounting) setImmediate(async () => {
      try {
        const { generateCreditNoteEntry } = require('../accounting/autoEntries.service');
        await generateCreditNoteEntry(noteSale, noteItems, tenantId, userId);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de la nota crédito ${noteSale.id}: ${err.message}`);
      }
    });

    // Enviar a DIAN (async)
    const tenant = await Tenant.findByPk(tenantId);
    setImmediate(async () => {
      try {
        await dianService.sendCreditNoteToDian({
          ...noteSale.toJSON(),
          items: noteItems,
          reference_sale_id: original.id,
          reference_invoice_number: original.dian_invoice_number || original.sale_number,
          reference_invoice_cufe: original.cufe,
          reference_invoice_date: original.sale_date,
        }, tenant);
        logger.info(`[DIAN] NC ${noteNumber} enviada para factura ${original.sale_number}`);
      } catch (err) {
        logger.error(`[DIAN] Error enviando NC ${noteNumber}:`, err.message);
        await Sale.update({ dian_status: 'rejected', dian_error_message: err.message }, { where: { id: noteSale.id } });
      }
    });

    return { noteSale, noteItems, original };
  } catch (e) {
    if (transaction && !transaction.finished) await transaction.rollback();
    throw e;
  }
}

module.exports = { createAndSendCreditNote };
