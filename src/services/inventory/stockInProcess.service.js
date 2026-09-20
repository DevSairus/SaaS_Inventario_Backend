// backend/src/services/inventory/stockInProcess.service.js
//
// "Cantidad en trámite" (Sprint 3, ver 00 - Documentación/Pitbox-Tecnicos-
// InventarioFisico-EnTramite-Analisis-y-Plan.md, sección 3.4).
//
// Se calcula al leer, NO se almacena -- evita la deriva que ya sufre
// products.available_stock/reserved_stock (H3 del documento de análisis).
//
// "En trámite" = compromisos que TODAVÍA NO bajaron products.current_stock
// pero ya están comprometidos con un documento:
//   - Ítems de venta en un borrador real (status='draft', document_type
//     null -- una cotización tiene document_type='cotizacion' y NO cuenta,
//     D3 del documento).
//   - Ítems de OT tipo 'repuesto', aprobados, que todavía no se "aplicaron"
//     al inventario (inventory_movement_id IS NULL). Tras la Fase 0,
//     addItem() de la OT ya descuenta current_stock al agregar un repuesto
//     normal (queda con inventory_movement_id seteado), así que ESOS no
//     cuentan acá -- solo cuentan los ítems que llegaron aprobados por una
//     cotización de cliente y aún no pasaron por applyApprovedItems.
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Sale, SaleItem, WorkOrder, WorkOrderItem, Product } = require('../../models');

/**
 * Calcula, para un lote de productos, cuánta cantidad está "en trámite"
 * (comprometida por documentos que todavía no bajaron el stock).
 *
 * @param {string} tenantId
 * @param {string[]} productIds - hasta ~200 (una página de productos)
 * @param {object} [opts]
 * @param {string} [opts.excludeSaleId] - no contar la venta que se está editando
 * @param {string} [opts.excludeWorkOrderId] - no contar la OT que se está editando
 * @param {import('sequelize').Transaction} [opts.transaction]
 * @returns {Promise<{ [productId: string]: { sales: number, work_orders: number, total: number } }>}
 */
async function getInProcessMap(tenantId, productIds, opts = {}) {
  const map = {};
  const ids = Array.from(new Set((productIds || []).filter(Boolean)));
  if (ids.length === 0) return map;

  const { excludeSaleId, excludeWorkOrderId, transaction } = opts;

  const ensure = (productId) => {
    if (!map[productId]) map[productId] = { sales: 0, work_orders: 0, total: 0 };
    return map[productId];
  };

  // ── Ventas en borrador (no cotizaciones) ────────────────────────────────
  const saleItemWhere = {
    product_id: { [Op.in]: ids },
    item_type: { [Op.notIn]: ['service', 'free_line'] },
    approval_status: { [Op.ne]: 'rechazado' },
  };
  if (excludeSaleId) saleItemWhere.sale_id = { [Op.ne]: excludeSaleId };

  const saleRows = await SaleItem.findAll({
    where: saleItemWhere,
    attributes: [
      'product_id',
      [sequelize.fn('SUM', sequelize.col('SaleItem.quantity')), 'qty'],
    ],
    include: [{
      model: Sale,
      as: 'sale',
      attributes: [],
      required: true,
      where: {
        tenant_id: tenantId,
        status: 'draft',
        document_type: null,
      },
    }],
    group: ['SaleItem.product_id'],
    raw: true,
    transaction,
  });

  for (const row of saleRows) {
    const qty = parseFloat(row.qty) || 0;
    const entry = ensure(row.product_id);
    entry.sales += qty;
    entry.total += qty;
  }

  // ── Ítems de OT aprobados, aún sin aplicar (inventory_movement_id null) ──
  const woItemWhere = {
    product_id: { [Op.in]: ids },
    item_type: 'repuesto',
    approval_status: 'aprobado',
    inventory_movement_id: null,
  };
  if (excludeWorkOrderId) woItemWhere.work_order_id = { [Op.ne]: excludeWorkOrderId };

  const woRows = await WorkOrderItem.findAll({
    where: woItemWhere,
    attributes: [
      'product_id',
      [sequelize.fn('SUM', sequelize.col('WorkOrderItem.quantity')), 'qty'],
    ],
    include: [
      {
        model: WorkOrder,
        as: 'work_order',
        attributes: [],
        required: true,
        where: {
          tenant_id: tenantId,
          status: { [Op.notIn]: ['cancelado', 'entregado'] },
          sale_id: null,
        },
      },
      {
        model: Product,
        as: 'product',
        attributes: [],
        required: true,
        where: { track_inventory: true },
      },
    ],
    group: ['WorkOrderItem.product_id'],
    raw: true,
    transaction,
  });

  for (const row of woRows) {
    const qty = parseFloat(row.qty) || 0;
    const entry = ensure(row.product_id);
    entry.work_orders += qty;
    entry.total += qty;
  }

  return map;
}

/**
 * Construye advertencias (NO bloqueantes) para un lote de solicitudes de
 * cantidad sobre productos, comparando contra el disponible real
 * (current_stock - en trámite de OTROS documentos).
 *
 * @param {string} tenantId
 * @param {Array<{ product_id: string, quantity: number, product_name?: string, current_stock?: number, track_inventory?: boolean }>} requests
 * @param {object} [opts]
 * @param {string} [opts.excludeSaleId]
 * @param {string} [opts.excludeWorkOrderId]
 * @param {import('sequelize').Transaction} [opts.transaction]
 * @returns {Promise<Array<{ product_id: string, product_name: string, requested_qty: number, in_process_qty: number, available_real: number, message: string }>>}
 */
async function buildStockWarnings(tenantId, requests, opts = {}) {
  const list = (requests || []).filter(r => r && r.product_id && parseFloat(r.quantity) > 0);
  if (list.length === 0) return [];

  const productIds = list.map(r => r.product_id);

  // Completar current_stock/track_inventory/name de los que no vinieron con
  // esos datos ya cargados (evita una consulta si el caller ya tiene el
  // producto en memoria, p.ej. sales.controller.js#create ya hizo el
  // batch-load de productos).
  const missingIds = list.filter(r => r.current_stock === undefined || r.track_inventory === undefined || !r.product_name).map(r => r.product_id);
  let productMap = {};
  if (missingIds.length > 0) {
    const rows = await Product.findAll({
      where: { id: { [Op.in]: Array.from(new Set(missingIds)) }, tenant_id: tenantId },
      attributes: ['id', 'name', 'current_stock', 'track_inventory'],
      transaction: opts.transaction,
    });
    productMap = Object.fromEntries(rows.map(p => [p.id, p]));
  }

  const inProcessMap = await getInProcessMap(tenantId, productIds, opts);

  const warnings = [];
  for (const req of list) {
    const fallback = productMap[req.product_id];
    const trackInventory = req.track_inventory !== undefined ? req.track_inventory : fallback?.track_inventory;
    if (trackInventory === false) continue;

    const currentStock = parseFloat(req.current_stock !== undefined ? req.current_stock : fallback?.current_stock ?? 0) || 0;
    const inProcessQty = inProcessMap[req.product_id]?.total || 0;
    const availableReal = currentStock - inProcessQty;
    const requestedQty = parseFloat(req.quantity) || 0;

    if (requestedQty > availableReal) {
      const productName = req.product_name || fallback?.name || req.product_id;
      warnings.push({
        product_id: req.product_id,
        product_name: productName,
        requested_qty: requestedQty,
        in_process_qty: inProcessQty,
        available_real: availableReal,
        message: inProcessQty > 0
          ? `Otros documentos en trámite ya comprometen ${inProcessQty} unidades de "${productName}". Disponible real: ${availableReal}.`
          : `Stock insuficiente en firme para "${productName}". Disponible real: ${availableReal}.`,
      });
    }
  }

  return warnings;
}

module.exports = { getInProcessMap, buildStockWarnings };
