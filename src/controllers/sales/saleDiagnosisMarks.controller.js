// backend/src/controllers/sales/saleDiagnosisMarks.controller.js
//
// Mapa de intervención para COTIZACIONES (Sale.document_type='cotizacion')
// con el campo vehículo habilitado — mismo catálogo de DiagramTemplate y
// misma UX que ya existe en Órdenes de Trabajo (ver
// controllers/workshop/workOrders.controller.js), pero las marcas viven en
// sale_diagnosis_marks y los ítems generados caen en sale_items.
// Requiere el módulo 'workshop' activo (gateado en las rutas), aunque viva
// bajo /api/sales — es la misma pieza de producto, solo aplicada a otro
// documento.
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const {
  Sale, SaleItem, DiagramTemplate, SaleDiagnosisMark, Product, User,
  WorkOrder, WorkOrderItem, WorkOrderDiagnosisMark, Vehicle, Customer, Tenant,
} = require('../../models');
const { Op } = require('sequelize');
const taxService = require('../../services/taxService');

const DIAGNOSIS_MARK_INCLUDE = [
  { model: Product, as: 'suggested_product', attributes: ['id', 'name', 'sku', 'base_price'], required: false },
  { model: User, as: 'marked_by_user', attributes: ['id', 'first_name', 'last_name'], required: false },
  { model: DiagramTemplate, as: 'diagram_template', attributes: ['id', 'name', 'system', 'configuration'], required: false },
];

// Solo cotizaciones en borrador pueden llevar diagrama editable — una vez
// confirmada/facturada, la cotización ya no debería seguir cambiando.
async function findEditableQuote(req, res) {
  const tenant_id = req.tenant_id;
  const sale = await Sale.findOne({ where: { id: req.params.id, tenant_id } });
  if (!sale) { res.status(404).json({ success: false, message: 'Cotización no encontrada' }); return null; }
  // Una venta nace con document_type=null y solo se define al confirmarla
  // (ver sales.controller.js: confirmSale). Se trata null como "todavía
  // puede terminar siendo cotización" — igual que ya hace el frontend en
  // el badge del detalle — y solo se rechaza si YA se confirmó como
  // remisión o factura (esos dos sí son definitivos).
  if (sale.document_type === 'remision' || sale.document_type === 'factura') {
    res.status(400).json({ success: false, message: 'El diagrama solo aplica a cotizaciones' });
    return null;
  }
  return sale;
}

const listDiagnosisMarks = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const sale = await Sale.findOne({ where: { id: req.params.id, tenant_id } });
    if (!sale) return res.status(404).json({ success: false, message: 'Cotización no encontrada' });

    const marks = await SaleDiagnosisMark.findAll({
      where: { sale_id: sale.id, tenant_id },
      include: DIAGNOSIS_MARK_INCLUDE,
      order: [['marked_at', 'ASC']],
    });
    res.json({ success: true, data: marks });
  } catch (error) {
    logger.error('Error listando marcas de diagnóstico de la cotización:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las marcas del diagrama' });
  }
};

const addDiagnosisMark = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const sale = await findEditableQuote(req, res);
    if (!sale) return;
    if (sale.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Solo se pueden agregar marcas a una cotización en borrador' });
    }

    const { diagram_template_id, point_number, severity, side, observation, suggested_product_id } = req.body;
    if (!diagram_template_id || !point_number) {
      return res.status(400).json({ success: false, message: 'El diagrama y el número de punto son requeridos' });
    }

    const template = await DiagramTemplate.findOne({
      where: { id: diagram_template_id, is_active: true, [Op.or]: [{ tenant_id: null }, { tenant_id }] },
    });
    if (!template) return res.status(404).json({ success: false, message: 'Diagrama no encontrado' });

    const pointExists = (template.points || []).some(p => p.point_number === parseInt(point_number));
    if (!pointExists) {
      return res.status(400).json({ success: false, message: 'Ese punto no existe en el diagrama seleccionado' });
    }

    const mark = await SaleDiagnosisMark.create({
      tenant_id,
      sale_id: sale.id,
      diagram_template_id,
      point_number: parseInt(point_number),
      severity: severity || 'revisar',
      side: side || null,
      observation: observation || null,
      suggested_product_id: suggested_product_id || null,
      marked_by: req.user.id,
    });

    const full = await SaleDiagnosisMark.findByPk(mark.id, { include: DIAGNOSIS_MARK_INCLUDE });
    res.status(201).json({ success: true, message: 'Marca registrada', data: full });
  } catch (error) {
    logger.error('Error agregando marca de diagnóstico a la cotización:', error);
    res.status(500).json({ success: false, message: 'Error al registrar la marca' });
  }
};

const updateDiagnosisMark = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const mark = await SaleDiagnosisMark.findOne({
      where: { id: req.params.markId, sale_id: req.params.id, tenant_id },
    });
    if (!mark) return res.status(404).json({ success: false, message: 'Marca no encontrada' });
    if (mark.generated_item_id) {
      return res.status(400).json({ success: false, message: 'Esta marca ya generó una línea y no se puede editar' });
    }

    const { severity, side, observation, suggested_product_id } = req.body;
    await mark.update({
      severity: severity || mark.severity,
      side: side !== undefined ? side : mark.side,
      observation: observation !== undefined ? observation : mark.observation,
      suggested_product_id: suggested_product_id !== undefined ? suggested_product_id : mark.suggested_product_id,
    });

    const full = await SaleDiagnosisMark.findByPk(mark.id, { include: DIAGNOSIS_MARK_INCLUDE });
    res.json({ success: true, message: 'Marca actualizada', data: full });
  } catch (error) {
    logger.error('Error actualizando marca de diagnóstico de la cotización:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la marca' });
  }
};

const removeDiagnosisMark = async (req, res) => {
  try {
    const tenant_id = req.tenant_id;
    const mark = await SaleDiagnosisMark.findOne({
      where: { id: req.params.markId, sale_id: req.params.id, tenant_id },
    });
    if (!mark) return res.status(404).json({ success: false, message: 'Marca no encontrada' });
    if (mark.generated_item_id) {
      return res.status(400).json({ success: false, message: 'Esta marca ya generó una línea — elimina la línea primero' });
    }

    await mark.destroy();
    res.json({ success: true, message: 'Marca eliminada' });
  } catch (error) {
    logger.error('Error eliminando marca de diagnóstico de la cotización:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la marca' });
  }
};

/**
 * POST /sales/:id/diagnosis-marks/generate-items
 * Convierte las marcas con producto sugerido en líneas de la cotización.
 * A diferencia de OT (que tiene un endpoint de "add item" incremental),
 * Sale.update() reemplaza todo el arreglo de items — por eso aquí se
 * inserta la línea directamente y se recalculan los totales de la
 * cabecera sumando TODOS los items existentes, con el mismo cálculo de
 * impuestos que usa sales.controller.js (taxService.calculateItemTaxes).
 */
const generateItemsFromMarks = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.tenant_id;
    const sale = await Sale.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!sale) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Cotización no encontrada' }); }
    if (sale.status !== 'draft') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo se pueden generar líneas en una cotización en borrador' });
    }

    const { mark_ids } = req.body;
    const where = { sale_id: sale.id, tenant_id, generated_item_id: null, suggested_product_id: { [Op.ne]: null } };
    if (Array.isArray(mark_ids) && mark_ids.length) where.id = { [Op.in]: mark_ids };

    const marks = await SaleDiagnosisMark.findAll({ where, transaction });
    if (!marks.length) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay marcas pendientes con producto sugerido para generar' });
    }

    const created = [];
    // tax_config del tenant — para resolver ICA por categoría (Fase D), igual
    // que en sales.controller.js.
    const tenantTaxConfigRow = await Tenant.findByPk(tenant_id, { attributes: ['tax_config'], transaction });
    const tenantTaxConfig = tenantTaxConfigRow?.tax_config || {};
    for (const mark of marks) {
      const product = await Product.findOne({ where: { id: mark.suggested_product_id, tenant_id }, transaction });
      if (!product) continue;

      const draftItem = { quantity: 1, unit_price: parseFloat(product.base_price) || 0, discount_percentage: 0 };
      const taxes = taxService.calculateItemTaxes(draftItem, product, 'sale', tenantTaxConfig);

      const item = await SaleItem.create({
        sale_id: sale.id, tenant_id,
        item_type: product.product_type === 'service' ? 'service' : 'product',
        product_id: product.id, product_name: product.name, product_sku: product.sku,
        quantity: draftItem.quantity, unit_price: draftItem.unit_price,
        discount_percentage: 0, discount_amount: 0,
        tax_percentage: taxes.iva.rate, tax_amount: taxes.iva.amount,
        inc_rate: taxes.inc.rate, inc_amount: taxes.inc.amount,
        ica_rate: taxes.ica.rate, ica_amount: taxes.ica.amount,
        subtotal: taxes.base, total: taxes.total_line,
        unit_cost: product.product_type === 'service' ? 0 : (product.average_cost || 0),
      }, { transaction });

      await mark.update({ generated_item_id: item.id }, { transaction });
      created.push(item);
    }

    // Recalcular totales de cabecera sumando todos los items (los que ya
    // había + los nuevos), igual que hace sales.controller.js/update().
    const allItems = await SaleItem.findAll({ where: { sale_id: sale.id }, transaction });
    const subtotal        = allItems.reduce((s, i) => s + parseFloat(i.subtotal), 0);
    const tax_amount       = allItems.reduce((s, i) => s + parseFloat(i.tax_amount) + parseFloat(i.inc_amount || 0) + parseFloat(i.ica_amount || 0), 0);
    const discount_amount  = allItems.reduce((s, i) => s + parseFloat(i.discount_amount || 0), 0);
    const total_amount     = allItems.reduce((s, i) => s + parseFloat(i.total), 0);
    await sale.update({ subtotal, tax_amount, discount_amount, total_amount }, { transaction });

    await transaction.commit();
    res.status(201).json({ success: true, message: `${created.length} línea(s) generadas desde el diagrama`, data: created });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error generando líneas desde marcas de diagnóstico:', error);
    res.status(500).json({ success: false, message: 'Error al generar las líneas' });
  }
};

// ── Conversión cotización → Orden de Trabajo ────────────────────────────────

async function generateWorkOrderNumber(tenant_id, transaction) {
  const year   = new Date().getFullYear();
  const prefix = `OT-${year}-`;
  const last   = await WorkOrder.findOne({
    where: { tenant_id, order_number: { [Op.like]: `${prefix}%` } },
    order: [['order_number', 'DESC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  const lastSeq = last ? parseInt(last.order_number.replace(prefix, ''), 10) : 0;
  const seq = (isNaN(lastSeq) ? 0 : lastSeq) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// SaleItem.item_type ('product'|'service'|'free_line') → WorkOrderItem.item_type
// ('repuesto'|'servicio'|'mano_obra'|'free_line'). No hay forma de distinguir
// 'servicio' de 'mano_obra' automáticamente — se asume 'servicio' por
// defecto; el técnico puede corregirlo desde la OT ya creada.
function mapItemType(saleItemType) {
  if (saleItemType === 'service') return 'servicio';
  if (saleItemType === 'free_line') return 'free_line';
  return 'repuesto';
}

/**
 * POST /sales/:id/convert-to-work-order
 * body: { vehicle_id? , vehicle: { plate, brand, model, year, color, vehicle_type } }
 * Convierte una cotización (con Taller habilitado) en una OT lista para
 * trabajar: copia cliente, líneas y — si la cotización tenía diagrama de
 * intervención marcado — también las marcas, hacia work_order_diagnosis_marks.
 * Solo pide el vehículo (existente o para crear), porque es el único dato
 * que la cotización no tiene y la OT sí exige.
 */
const convertToWorkOrder = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.tenant_id;
    const sale = await Sale.findOne({ where: { id: req.params.id, tenant_id }, transaction, include: [{ model: SaleItem, as: 'items' }] });
    if (!sale) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Cotización no encontrada' }); }
    if (sale.document_type === 'remision' || sale.document_type === 'factura') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Solo una cotización se puede convertir en Orden de Trabajo' });
    }
    if (sale.converted_to_work_order_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta cotización ya fue convertida en una Orden de Trabajo' });
    }

    let { vehicle_id, vehicle } = req.body;
    if (!vehicle_id) {
      if (!vehicle || !vehicle.plate) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'Selecciona un vehículo existente o registra uno nuevo (placa requerida)' });
      }
      const plate = vehicle.plate.trim().toUpperCase();
      let veh = await Vehicle.findOne({ where: { tenant_id, plate } , transaction });
      if (!veh) {
        veh = await Vehicle.create({
          tenant_id, plate,
          brand: vehicle.brand || sale.vehicle_brand || null,
          model: vehicle.model || sale.vehicle_model || null,
          year: vehicle.year || sale.vehicle_year || null,
          color: vehicle.color || sale.vehicle_color || null,
          vehicle_type: vehicle.vehicle_type || sale.vehicle_type || 'automovil',
          customer_id: sale.customer_id || null,
        }, { transaction });
      }
      vehicle_id = veh.id;
    }

    const order_number = await generateWorkOrderNumber(tenant_id, transaction);
    const order = await WorkOrder.create({
      tenant_id, order_number, vehicle_id,
      customer_id: sale.customer_id || null,
      warehouse_id: sale.warehouse_id || null,
      problem_description: sale.notes || null,
      quote_sale_id: sale.id,
      created_by: req.user.id,
      received_at: new Date(),
    }, { transaction });

    // Copiar líneas de la cotización a la OT
    for (const item of sale.items) {
      await WorkOrderItem.create({
        tenant_id, work_order_id: order.id,
        item_type: mapItemType(item.item_type),
        product_id: item.product_id, product_name: item.product_name, product_sku: item.product_sku,
        quantity: item.quantity, unit_price: item.unit_price,
        discount_percentage: item.discount_percentage, discount_amount: item.discount_amount,
        tax_percentage: item.tax_percentage, tax_amount: item.tax_amount,
        subtotal: item.subtotal, total: item.total,
        approval_status: 'aprobado',
      }, { transaction });
    }
    await order.update({
      subtotal: sale.subtotal, tax_amount: sale.tax_amount,
      discount_amount: sale.discount_amount, total_amount: sale.total_amount,
    }, { transaction });

    // Copiar el diagnóstico marcado en la cotización (si lo había)
    const quoteMarks = await SaleDiagnosisMark.findAll({ where: { sale_id: sale.id, tenant_id }, transaction });
    for (const m of quoteMarks) {
      await WorkOrderDiagnosisMark.create({
        tenant_id, work_order_id: order.id,
        diagram_template_id: m.diagram_template_id,
        point_number: m.point_number, severity: m.severity, side: m.side,
        observation: m.observation, suggested_product_id: m.suggested_product_id,
        marked_by: m.marked_by, marked_at: m.marked_at,
        // generated_item_id NO se copia — apuntaba a un SaleItem, no a un
        // WorkOrderItem; queda sin ítem generado del lado de la OT hasta
        // que el técnico lo confirme de nuevo ahí si lo necesita.
      }, { transaction });
    }

    await sale.update({ converted_to_work_order_id: order.id }, { transaction });

    await transaction.commit();

    const full = await WorkOrder.findByPk(order.id, {
      include: [{ model: Vehicle, as: 'vehicle' }, { model: Customer, as: 'customer' }, { model: WorkOrderItem, as: 'items' }],
    });
    res.status(201).json({
      success: true,
      message: `Orden de trabajo ${order.order_number} creada desde la cotización${quoteMarks.length ? ` (con ${quoteMarks.length} marca(s) de diagnóstico copiadas)` : ''}`,
      data: full,
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error convirtiendo cotización en OT:', error);
    res.status(500).json({ success: false, message: 'Error al convertir la cotización en Orden de Trabajo' });
  }
};

module.exports = {
  listDiagnosisMarks, addDiagnosisMark, updateDiagnosisMark, removeDiagnosisMark,
  generateItemsFromMarks, convertToWorkOrder,
};
