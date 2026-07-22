// backend/src/controllers/workshop/workOrders.controller.js
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const {
  WorkOrder, WorkOrderItem, WorkOrderQuoteRequest, Vehicle, Customer, User,
  Warehouse, Product, InventoryMovement, Sale, SaleItem,
} = require('../../models');
const { Op } = require('sequelize');
const { createMovement } = require('../inventory/movements.controller');
const Tenant = require('../../models/auth/Tenant');
const { getOpenSession, isTreasuryEnabled } = require('../../services/finance/cashSession.service');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Atributos seguros de WorkOrder — share_token ya existe tras la migración
const WO_SAFE_ATTRS = [
  'id','tenant_id','order_number','vehicle_id','customer_id','technician_id',
  'warehouse_id','status','mileage_in','mileage_out','problem_description',
  'diagnosis','work_performed','photos_in','photos_out','received_at',
  'promised_at','completed_at','delivered_at','subtotal','tax_amount',
  'discount_amount','total_amount','paid_amount','payment_status','sale_id','notes','internal_notes',
  'created_by','created_at','updated_at','share_token',
];

// Include para cargar el técnico responsable de cada ítem
const ITEM_TECHNICIAN_INCLUDE = {
  model: User, as: 'item_technician', attributes: ['id', 'first_name', 'last_name'], required: false,
};

async function generateOrderNumber(tenant_id, transaction) {
  const year   = new Date().getFullYear();
  const prefix = `OT-${year}-`;
  const last   = await WorkOrder.findOne({
    where: { tenant_id, order_number: { [Op.like]: `${prefix}%` } },
    order: [['order_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction,
  });
  const lastSeq = last ? parseInt(last.order_number.replace(prefix, ''), 10) : 0;
  const seq = (isNaN(lastSeq) ? 0 : lastSeq) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

async function generateMovementNumber(tenant_id, transaction) {
  const year = new Date().getFullYear();
  const last  = await InventoryMovement.findOne({
    where: { tenant_id, movement_number: { [Op.like]: `MOV-${year}-%` } },
    order: [['movement_number', 'DESC']],
    transaction,
  });
  const seq = last ? parseInt(last.movement_number.split('-')[2]) + 1 : 1;
  return `MOV-${year}-${String(seq).padStart(5, '0')}`;
}

// Soporte de detección de conflictos para la cola de sincronización offline
// de la PWA "Taller" (frontend/src/pwa/offlineQueue/syncManager.js): el
// cliente manda `expected_updated_at` = el `updated_at` que conocía cuando
// editó sin conexión. Si no coincide con el actual, alguien más modificó el
// registro mientras tanto → 409, sin aplicar el cambio (el frontend decide:
// descartar o forzar sobrescritura). Si no viene el campo (llamadas normales
// sin offline), no se bloquea nada — mismo comportamiento de siempre.
function popExpectedVersion(body) {
  const { expected_updated_at, ...rest } = body || {};
  return { expectedVersion: expected_updated_at, rest };
}

function hasVersionConflict(record, expectedVersion) {
  if (!expectedVersion) return false;
  const current  = new Date(record.updated_at).getTime();
  const expected = new Date(expectedVersion).getTime();
  return !isNaN(current) && !isNaN(expected) && current !== expected;
}

// Solo los ítems 'aprobado' (default para los que no usan cotización) cuentan
// en los totales de la OT — un ítem 'pendiente' todavía no tiene luz verde
// del cliente y uno 'rechazado' no se va a cobrar, así que ninguno de los
// dos debe inflar lo que se factura.
function calcTotals(items) {
  const billable    = items.filter(i => (i.approval_status || 'aprobado') === 'aprobado');
  const subtotal   = billable.reduce((s, i) => s + parseFloat(i.subtotal   || 0), 0);
  const tax_amount = billable.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
  return { subtotal, tax_amount, total_amount: subtotal + tax_amount };
}

// WorkOrderItem.item_type ('repuesto'/'servicio'/'mano_obra'/'free_line') no
// comparte vocabulario con SaleItem.item_type ('product'/'service'/'free_line')
// — al generar la remisión/factura desde la OT hay que traducir uno al otro
// para que autoEntries.service.js reconozca correctamente el ingreso.
function mapWorkOrderItemTypeToSale(workOrderItemType) {
  if (workOrderItemType === 'repuesto') return 'product';
  if (workOrderItemType === 'free_line') return 'free_line';
  return 'service'; // 'servicio' | 'mano_obra'
}

/**
 * Descuenta inventario por un ítem tipo 'repuesto' con track_inventory y
 * registra el InventoryMovement correspondiente. Extraído de addItem() para
 * poder reutilizarlo también cuando el cliente aprueba una cotización y el
 * taller aplica esos ítems (ver applyApprovedItems) — en ese caso el
 * descuento sucede recién en ese momento, no cuando se agregó el ítem.
 * Lanza error si la OT no tiene bodega asignada; el llamador decide cómo
 * responder (rollback + mensaje al usuario).
 */
async function applyItemStockMovement(item, order, product, tenant_id, user_id, transaction) {
  if (!order.warehouse_id) {
    throw new Error('La OT debe tener una bodega asignada para descontar repuestos');
  }

  const qty = parseFloat(item.quantity);
  const previous_stock = parseFloat(product.current_stock) || 0;
  const new_stock      = previous_stock - qty;
  const unit_cost_val  =
    parseFloat(product.average_cost) ||
    parseFloat(product.purchase_price) ||
    parseFloat(item.unit_price);

  const movement_number = await generateMovementNumber(tenant_id, transaction);

  await product.update({ current_stock: new_stock }, { transaction });

  const movement = await InventoryMovement.create({
    tenant_id,
    movement_number,
    movement_type:   'sale',
    direction:       'out',
    movement_reason: 'taller_repuesto',
    reference_type:  'work_order',
    reference_id:    order.id,
    product_id:      product.id,
    warehouse_id:    order.warehouse_id,
    quantity:        qty,
    unit_cost:       unit_cost_val,
    total_cost:      qty * unit_cost_val,
    previous_stock,
    new_stock,
    user_id,
    movement_date:   new Date(),
    notes:           `Repuesto OT ${order.order_number}: ${product.name}`,
  }, { transaction });

  await item.update({ inventory_movement_id: movement.id }, { transaction });
  return movement;
}

// ── LIST ─────────────────────────────────────────────────────────────────────

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status, technician_id, customer_id, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const where = { tenant_id };
    if (status) {
      // Soportar múltiples estados separados por coma: "recibido,en_proceso,listo"
      const statusList = status.split(',').map(s => s.trim()).filter(Boolean);
      where.status = statusList.length === 1 ? statusList[0] : { [Op.in]: statusList };
    }
    if (technician_id) where.technician_id = technician_id;
    if (customer_id)   where.customer_id   = customer_id;
    if (search) {
      where[Op.or] = [
        { order_number:         { [Op.iLike]: `%${search}%` } },
        { problem_description:  { [Op.iLike]: `%${search}%` } },
        { '$vehicle.plate$':           { [Op.iLike]: `%${search}%` } },
        { '$customer.first_name$':     { [Op.iLike]: `%${search}%` } },
        { '$customer.last_name$':      { [Op.iLike]: `%${search}%` } },
        { '$customer.business_name$':  { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { count, rows } = await WorkOrder.findAndCountAll({
      where,
      attributes: WO_SAFE_ATTRS,
      include: [
        { model: Vehicle,  as: 'vehicle',    attributes: ['id', 'plate', 'brand', 'model', 'year', 'color'] },
        { model: Customer, as: 'customer',   attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone'] },
        { model: User,     as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order:    [['received_at', 'DESC']],
      limit:    parseInt(limit),
      offset:   parseInt(offset),
      subQuery: false,
    });

    res.json({ success: true, data: rows, total: count, page: parseInt(page), pages: Math.ceil(count / limit) });
  } catch (error) {
    logger.error('Error listando OTs:', error);
    res.status(500).json({ success: false, message: 'Error al obtener órdenes de trabajo' });
  }
};

// ── GET BY ID ─────────────────────────────────────────────────────────────────

const getById = async (req, res) => {
  try {
    const order = await WorkOrder.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [
        { model: Vehicle,  as: 'vehicle' },
        { model: Customer, as: 'customer' },
        { model: User,     as: 'technician', attributes: ['id', 'first_name', 'last_name', 'phone'] },
        { model: User,     as: 'creator_wo', attributes: ['id', 'first_name', 'last_name'] },
        { model: Warehouse,as: 'warehouse',  attributes: ['id', 'name'] },
        { model: Sale,     as: 'sale',       attributes: ['id', 'sale_number', 'status', 'total_amount'] },
        {
          model: WorkOrderItem, as: 'items',
          include: [
            { model: Product, as: 'product', attributes: ['id', 'name', 'sku', 'current_stock', 'product_type'] },
            ITEM_TECHNICIAN_INCLUDE,
          ],
        },
        {
          model: WorkOrderQuoteRequest, as: 'quote_requests',
          separate: true,
          order: [['sent_at', 'DESC']],
        },
      ],
    });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    // Sequelize puede no incluir columnas JSONB añadidas post-creación — forzar con raw query
    const rows = await sequelize.query(
      'SELECT checklist_in FROM work_orders WHERE id = :id',
      { replacements: { id: req.params.id }, type: sequelize.QueryTypes.SELECT }
    );

    const data = order.toJSON();
    data.checklist_in = rows[0]?.checklist_in || {};

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error obteniendo OT:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la orden' });
  }
};

// ── CREATE ────────────────────────────────────────────────────────────────────

const create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const {
      vehicle_id, customer_id, technician_id, warehouse_id,
      mileage_in, problem_description, promised_at, notes,
    } = req.body;

    if (!vehicle_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El vehículo es requerido' });
    }

    const order_number = await generateOrderNumber(tenant_id, transaction);

    // Sanitizar campos UUID opcionales: convertir string vacío a null
    const sanitizedTechnicianId = technician_id || null;
    const sanitizedWarehouseId = warehouse_id || null;
    const sanitizedCustomerId = customer_id || null;

    if (mileage_in) {
      await Vehicle.update({ current_mileage: mileage_in }, { where: { id: vehicle_id, tenant_id }, transaction });
    }

    // Si el vehículo no tiene propietario y la OT lleva cliente, vincularlo permanentemente
    if (sanitizedCustomerId) {
      await Vehicle.update(
        { customer_id: sanitizedCustomerId },
        { where: { id: vehicle_id, tenant_id, customer_id: null }, transaction }
      );
    }

    const order = await WorkOrder.create({
      tenant_id, order_number, vehicle_id,
      customer_id: sanitizedCustomerId,
      technician_id: sanitizedTechnicianId,
      warehouse_id: sanitizedWarehouseId,
      mileage_in, problem_description, promised_at, notes,
      created_by: req.user.id,
      received_at: new Date(),
    }, { transaction });

    await transaction.commit();

    const full = await WorkOrder.findByPk(order.id, {
      include: [
        { model: Vehicle,  as: 'vehicle' },
        { model: Customer, as: 'customer' },
        { model: User,     as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
      ],
    });

    res.status(201).json({ success: true, message: 'Orden de trabajo creada', data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creando OT:', error);
    res.status(500).json({ success: false, message: 'Error al crear la orden' });
  }
};

// ── UPDATE ────────────────────────────────────────────────────────────────────

const update = async (req, res) => {
  try {
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (['entregado', 'cancelado'].includes(order.status))
      return res.status(400).json({ success: false, message: 'No se puede editar una OT cerrada' });

    const { expectedVersion, rest } = popExpectedVersion(req.body);
    if (hasVersionConflict(order, expectedVersion)) {
      return res.status(409).json({
        success: false,
        message: 'La orden fue modificada por otro usuario mientras estabas sin conexión',
        data: order,
      });
    }

    const {
      technician_id, warehouse_id, promised_at,
      problem_description, diagnosis, work_performed,
      notes, mileage_in, mileage_out, discount_amount,
    } = rest;

    await order.update({
      technician_id, warehouse_id, promised_at,
      problem_description, diagnosis, work_performed,
      notes, mileage_in, mileage_out,
      discount_amount: discount_amount != null ? parseFloat(discount_amount) : order.discount_amount,
    });

    const items = await WorkOrderItem.findAll({ where: { work_order_id: order.id } });
    const { subtotal, tax_amount } = calcTotals(items);
    const disc = parseFloat(order.discount_amount) || 0;
    await order.update({ subtotal, tax_amount, total_amount: subtotal + tax_amount - disc });

    res.json({ success: true, message: 'Orden actualizada', data: order });
  } catch (error) {
    logger.error('Error actualizando OT:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la orden' });
  }
};

// ── CHANGE STATUS ─────────────────────────────────────────────────────────────

const changeStatus = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { expectedVersion, rest } = popExpectedVersion(req.body);
    const { status, mileage_out } = rest;
    const validStatuses = ['recibido', 'en_proceso', 'en_espera', 'listo', 'entregado', 'cancelado'];
    if (!validStatuses.includes(status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Estado inválido' });
    }

    const order = await WorkOrder.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      transaction,
    });
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }

    if (hasVersionConflict(order, expectedVersion)) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        message: 'La orden fue modificada por otro usuario mientras estabas sin conexión',
        data: order,
      });
    }

    if (['entregado', 'cancelado'].includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `La OT ya está ${order.status} y no puede cambiar de estado` });
    }

    const updates = { status };
    if (status === 'listo')     updates.completed_at = new Date();
    if (status === 'entregado') {
      updates.delivered_at  = new Date();
      // Registrar km de salida si se proporciona
      if (mileage_out) {
        updates.mileage_out = parseInt(mileage_out);
        // Actualizar también el km actual del vehículo
        await Vehicle.update(
          { current_mileage: parseInt(mileage_out) },
          { where: { id: order.vehicle_id, tenant_id: req.user.tenant_id }, transaction }
        );
      }
    }

    // ── Cancelación: devolver stock de todos los repuestos descontados ──────────
    if (status === 'cancelado') {
      const items = await WorkOrderItem.findAll({
        where: { work_order_id: order.id },
        transaction,
      });

      for (const item of items) {
        if (item.item_type !== 'repuesto' || !item.inventory_movement_id) continue;

        const product = await Product.findByPk(item.product_id, { transaction });
        if (!product || !product.track_inventory) continue;

        const qty       = parseFloat(item.quantity);
        const prevStock = parseFloat(product.current_stock) || 0;
        const newStock  = prevStock + qty;

        await product.update({ current_stock: newStock }, { transaction });

        // Eliminar el movimiento de salida original para mantener el historial limpio
        await InventoryMovement.destroy({
          where: { id: item.inventory_movement_id },
          transaction,
        });

        // Limpiar la referencia en el ítem
        await item.update({ inventory_movement_id: null }, { transaction });

        logger.info(`OT cancelada: stock revertido ${product.name} +${qty} (${prevStock} → ${newStock})`);
      }
    }

    await order.update(updates, { transaction });
    await transaction.commit();

    // Retornar la OT completa con includes
    const full = await WorkOrder.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      include: [
        { model: Vehicle,  as: 'vehicle' },
        { model: Customer, as: 'customer' },
        { model: User,     as: 'technician', attributes: ['id', 'first_name', 'last_name', 'phone'] },
        { model: User,     as: 'creator_wo', attributes: ['id', 'first_name', 'last_name'] },
        { model: Warehouse,as: 'warehouse',  attributes: ['id', 'name'] },
        { model: Sale,     as: 'sale',       attributes: ['id', 'sale_number', 'status', 'total_amount'] },
        {
          model: WorkOrderItem, as: 'items',
          include: [
            { model: Product, as: 'product', attributes: ['id', 'name', 'sku', 'current_stock', 'product_type'] },
            ITEM_TECHNICIAN_INCLUDE,
          ],
        },
      ],
    });

    res.json({ success: true, message: `Estado actualizado a: ${status}`, data: full });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error cambiando estado OT:', error);
    res.status(500).json({ success: false, message: 'Error al cambiar estado' });
  }
};

// ── ADD ITEM ──────────────────────────────────────────────────────────────────

const addItem = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;

    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }
    if (['entregado', 'cancelado'].includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se pueden agregar ítems a una OT cerrada' });
    }

    const {
      product_id, item_type, quantity, unit_price, tax_percentage,
      technician_id: itemTechnicianId, requires_approval,
      product_name: freeLineName,
    } = req.body;

    if (!item_type || !quantity) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Tipo y cantidad son requeridos' });
    }

    // Cotización con aprobación del cliente: no descuenta inventario todavía,
    // así que tampoco tiene sentido bloquear por stock insuficiente ahora
    // mismo — puede llegar a reponerse antes de que el cliente apruebe.
    const requiresApproval = requires_approval === true || requires_approval === 'true' || requires_approval === 1;
    const qty = parseFloat(quantity);

    // ── Línea libre: ad-hoc, sin producto de catálogo — mismo criterio que
    // sales.controller.js. No busca producto, no valida ni descuenta stock.
    if (item_type === 'free_line') {
      if (!freeLineName || !freeLineName.trim()) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'La descripción de la línea libre es requerida' });
      }

      const price  = parseFloat(unit_price) || 0;
      const taxPct = parseFloat(tax_percentage ?? 19);
      const subtotal   = qty * price;
      const tax_amount = taxPct > 0 ? Math.round(subtotal * (taxPct / 100)) : 0;
      const total = subtotal + tax_amount;

      const item = await WorkOrderItem.create({
        tenant_id,
        work_order_id: order.id,
        item_type: 'free_line',
        product_id: null,
        product_name: freeLineName.trim(),
        product_sku: null,
        quantity: qty,
        unit_price: price,
        tax_percentage: taxPct,
        tax_amount,
        subtotal,
        total,
        technician_id: itemTechnicianId || null,
        approval_status: requiresApproval ? 'pendiente' : 'aprobado',
      }, { transaction });

      const allItemsFL = await WorkOrderItem.findAll({ where: { work_order_id: order.id }, transaction });
      const { subtotal: sFL, tax_amount: tFL } = calcTotals(allItemsFL);
      const discFL = parseFloat(order.discount_amount) || 0;
      await order.update({ subtotal: sFL, tax_amount: tFL, total_amount: sFL + tFL - discFL }, { transaction });

      await transaction.commit();
      return res.status(201).json({ success: true, message: 'Ítem agregado', data: item });
    }

    if (!product_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Producto, tipo y cantidad son requeridos' });
    }

    const product = await Product.findOne({ where: { id: product_id, tenant_id }, transaction });
    if (!product) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }

    // Validar combinación tipo/producto
    if (item_type === 'repuesto' && product.product_type === 'service') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Un producto de tipo servicio no puede ser "repuesto"' });
    }

    // Validar stock si es repuesto físico
    if (!requiresApproval && item_type === 'repuesto' && product.track_inventory && parseFloat(product.current_stock) < qty) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `Stock insuficiente. Disponible: ${product.current_stock}` });
    }

    // Calcular importes — respetar price_includes_tax y has_tax
    // Normalizar booleanos: Sequelize/PG puede devolver true/false/null/string/'true'/'false'
    const toBool = (v, def = false) => {
      if (v === true  || v === 'true'  || v === 1) return true;
      if (v === false || v === 'false' || v === 0) return false;
      return def;
    };

    const price           = parseFloat(unit_price) || parseFloat(product.base_price) || 0;
    const taxPct          = parseFloat(tax_percentage ?? product.tax_percentage ?? 19);
    const hasTax          = toBool(product.has_tax, true) && taxPct > 0;
    const priceIncludesTax = toBool(product.price_includes_tax, false);

    let subtotal, tax_amount;
    if (!hasTax) {
      // Producto exento de IVA
      subtotal   = qty * price;
      tax_amount = 0;
    } else if (priceIncludesTax) {
      // El precio ya incluye IVA — extraer el impuesto embebido
      const totalBruto = qty * price;
      subtotal   = Math.round(totalBruto / (1 + taxPct / 100));
      tax_amount = totalBruto - subtotal;
    } else {
      // Precio no incluye IVA — sumarlo encima
      subtotal   = qty * price;
      tax_amount = Math.round(subtotal * (taxPct / 100));
    }
    const total = subtotal + tax_amount;

    // Crear ítem
    const item = await WorkOrderItem.create({
      tenant_id,
      work_order_id: order.id,
      item_type,
      product_id,
      product_name: product.name,
      product_sku:  product.sku,
      quantity:     qty,
      unit_price:   price,
      tax_percentage: taxPct,
      tax_amount,
      subtotal,
      total,
      technician_id: itemTechnicianId || null,
      approval_status: requiresApproval ? 'pendiente' : 'aprobado',
    }, { transaction });

    // Descontar inventario si es repuesto físico con track_inventory —
    // salvo que requiera aprobación del cliente: en ese caso queda
    // 'pendiente' sin tocar inventario hasta que se apruebe (ver
    // applyApprovedItems), sea cual sea el momento de la OT en que se agregó.
    if (!requiresApproval && item_type === 'repuesto' && product.track_inventory) {
      try {
        await applyItemStockMovement(item, order, product, tenant_id, req.user.id, transaction);
      } catch (stockError) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: stockError.message });
      }
    }

    // Recalcular totales de la OT
    const allItems = await WorkOrderItem.findAll({ where: { work_order_id: order.id }, transaction });
    const { subtotal: s, tax_amount: t } = calcTotals(allItems);
    const disc = parseFloat(order.discount_amount) || 0;
    await order.update({ subtotal: s, tax_amount: t, total_amount: s + t - disc }, { transaction });

    await transaction.commit();

    res.status(201).json({ success: true, message: 'Ítem agregado', data: item });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error agregando ítem a OT:', error);
    res.status(500).json({ success: false, message: 'Error al agregar ítem' });
  }
};

// ── REMOVE ITEM ───────────────────────────────────────────────────────────────

const removeItem = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;

    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!order) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Orden no encontrada' }); }
    if (['entregado', 'cancelado'].includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se pueden eliminar ítems de una OT cerrada' });
    }

    const item = await WorkOrderItem.findOne({ where: { id: req.params.itemId, work_order_id: order.id }, transaction });
    if (!item) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Ítem no encontrado' }); }

    // Revertir inventario si aplica
    if (item.item_type === 'repuesto' && item.inventory_movement_id) {
      const product = await Product.findByPk(item.product_id, { transaction });
      if (product && product.track_inventory) {
        const restored = parseFloat(product.current_stock) + parseFloat(item.quantity);
        await product.update({ current_stock: restored }, { transaction });
        await InventoryMovement.destroy({ where: { id: item.inventory_movement_id }, transaction });
      }
    }

    await item.destroy({ transaction });

    // Recalcular totales
    const remaining = await WorkOrderItem.findAll({ where: { work_order_id: order.id }, transaction });
    const { subtotal, tax_amount } = calcTotals(remaining);
    const disc = parseFloat(order.discount_amount) || 0;
    await order.update({ subtotal, tax_amount, total_amount: subtotal + tax_amount - disc }, { transaction });

    await transaction.commit();
    res.json({ success: true, message: 'Ítem eliminado' });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error eliminando ítem OT:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar ítem' });
  }
};

// ── COTIZACIÓN CON APROBACIÓN DEL CLIENTE ───────────────────────────────────
// Ítems agregados con requires_approval:true quedan 'pendiente' sueltos
// (quote_request_id NULL) hasta que el taller decide mandarlos a aprobar —
// ese envío es lo que agrupa una "ronda" (WorkOrderQuoteRequest).

/**
 * POST /work-orders/:id/quote-requests
 * Agrupa los ítems 'pendiente' sueltos de la OT en una ronda nueva y arma
 * el enlace de WhatsApp para enviarla — mismo patrón que sendWhatsApp/
 * generateShareToken (reusa share_token, wa.me).
 */
const sendQuoteRequest = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }

    const pendingItems = await WorkOrderItem.findAll({
      where: { work_order_id: order.id, approval_status: 'pendiente', quote_request_id: null },
      transaction,
    });
    if (pendingItems.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay ítems pendientes de enviar a cotizar' });
    }

    const quoteRequest = await WorkOrderQuoteRequest.create({
      tenant_id,
      work_order_id: order.id,
      status: 'enviada',
    }, { transaction });

    await WorkOrderItem.update(
      { quote_request_id: quoteRequest.id },
      { where: { id: pendingItems.map(i => i.id) }, transaction }
    );

    // Reusar/crear share_token de la OT (mismo patrón que generateShareToken/sendWhatsApp)
    const rows = await sequelize.query(
      'SELECT share_token FROM work_orders WHERE id = :id',
      { replacements: { id: order.id }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    let token = rows[0]?.share_token;
    if (!token) {
      token = require('crypto').randomUUID();
      await sequelize.query(
        'UPDATE work_orders SET share_token = :token WHERE id = :id',
        { replacements: { token, id: order.id }, type: sequelize.QueryTypes.UPDATE, transaction }
      );
    }

    const customer = await Customer.findOne({ where: { id: order.customer_id }, transaction });
    const phone = customer?.mobile || customer?.phone || '';
    const cleanPhone = phone.replace(/\D/g, '');

    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-app.vercel.app';
    const shareUrl = `${frontendUrl}/ot/${token}`;
    const itemsSummary = pendingItems.map(i => `• ${i.product_name} (${i.quantity} x ${i.total})`).join('\n');
    const whatsappText = encodeURIComponent(
      `Hola! Tenemos una cotización pendiente de tu aprobación para la orden ${order.order_number}:\n${itemsSummary}\n\nRevísala y apruébala aquí:\n${shareUrl}`
    );
    const whatsappUrl = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${whatsappText}`
      : `https://wa.me/?text=${whatsappText}`;

    await transaction.commit();

    res.status(201).json({
      success: true,
      message: 'Cotización enviada',
      data: { quote_request_id: quoteRequest.id, share_url: shareUrl, whatsapp_url: whatsappUrl, items_count: pendingItems.length },
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error enviando cotización:', error);
    res.status(500).json({ success: false, message: 'Error al enviar la cotización' });
  }
};

/**
 * POST /work-orders/:id/quote-requests/:quoteRequestId/apply
 * Descuenta inventario de los ítems 'aprobado' de esa ronda que todavía no
 * se hayan aplicado — recién en este momento se toca inventario, nunca
 * antes (ver applyItemStockMovement / diseño en addItem).
 */
const applyApprovedItems = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }

    const quoteRequest = await WorkOrderQuoteRequest.findOne({
      where: { id: req.params.quoteRequestId, work_order_id: order.id },
      transaction,
    });
    if (!quoteRequest) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cotización no encontrada' });
    }

    const items = await WorkOrderItem.findAll({
      where: { quote_request_id: quoteRequest.id, approval_status: 'aprobado', inventory_movement_id: null },
      transaction,
    });

    let applied = 0;
    for (const item of items) {
      if (item.item_type !== 'repuesto') continue; // servicio/mano_obra no descuenta inventario
      const product = await Product.findByPk(item.product_id, { transaction });
      if (!product || !product.track_inventory) continue;
      await applyItemStockMovement(item, order, product, tenant_id, req.user.id, transaction);
      applied += 1;
    }

    await transaction.commit();
    res.json({ success: true, message: `${applied} ítem(s) aplicado(s) — inventario descontado`, data: { applied } });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error aplicando ítems aprobados:', error);
    res.status(500).json({ success: false, message: error.message || 'Error al aplicar los ítems aprobados' });
  }
};

/**
 * POST /public/work-orders/:token/quote-requests/:quoteRequestId/respond
 * Endpoint PÚBLICO (sin autenticación) — el cliente aprueba/rechaza los
 * ítems de la ronda activa. Bloqueo total: si la ronda ya no está en
 * 'enviada', se rechaza con 409 sin tocar nada (protege contra doble envío,
 * reintento, o reabrir un link viejo).
 */
const respondQuoteRequest = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { token, quoteRequestId } = req.params;
    const { approvals, approved_by_name, approved_by_document } = req.body;

    if (!approved_by_name || !approved_by_document) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Nombre y documento son requeridos para responder' });
    }
    if (!Array.isArray(approvals) || approvals.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se recibió ninguna decisión' });
    }

    const rows = await sequelize.query(
      'SELECT id FROM work_orders WHERE share_token = :token LIMIT 1',
      { replacements: { token }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    const order = rows[0];
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada o enlace inválido' });
    }

    // Bloqueo total: si la ronda ya fue respondida, no se acepta un segundo envío.
    const quoteRequest = await WorkOrderQuoteRequest.findOne({
      where: { id: quoteRequestId, work_order_id: order.id },
      transaction,
    });
    if (!quoteRequest || quoteRequest.status !== 'enviada') {
      await transaction.rollback();
      return res.status(409).json({ success: false, message: 'Esta cotización ya fue respondida anteriormente' });
    }

    for (const a of approvals) {
      await WorkOrderItem.update(
        {
          approval_status: a.approved ? 'aprobado' : 'rechazado',
          rejection_reason: a.approved ? null : (a.rejection_reason || null),
        },
        { where: { id: a.item_id, work_order_id: order.id, quote_request_id: quoteRequestId }, transaction }
      );
    }

    await quoteRequest.update(
      {
        status: 'respondida',
        responded_at: new Date(),
        approved_by_name,
        approved_by_document,
        approved_ip: req.ip,
      },
      { transaction }
    );

    // Recalcular totales de la OT — los ítems recién aprobados ahora sí
    // cuentan en lo que se factura (ver calcTotals).
    const fullOrder = await WorkOrder.findByPk(order.id, { transaction });
    const allItems = await WorkOrderItem.findAll({ where: { work_order_id: order.id }, transaction });
    const { subtotal, tax_amount } = calcTotals(allItems);
    const disc = parseFloat(fullOrder.discount_amount) || 0;
    await fullOrder.update({ subtotal, tax_amount, total_amount: subtotal + tax_amount - disc }, { transaction });

    await transaction.commit();

    // TODO: notificar al taller (wa.me / mismo mecanismo que accountsPayable
    // / stockAlerts) — pendiente definir si es inmediato o basta con que el
    // taller lo vea la próxima vez que entra a Pitbox.

    res.json({ success: true, message: 'Respuesta registrada correctamente' });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error en respondQuoteRequest:', error);
    res.status(500).json({ success: false, message: 'Error al procesar la respuesta' });
  }
};

// ── GENERATE REMISION ─────────────────────────────────────────────────────────

const generateSale = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;

    const order = await WorkOrder.findOne({
      where: { id: req.params.id, tenant_id },
      include: [
        { model: WorkOrderItem, as: 'items' },
        { model: Vehicle,       as: 'vehicle' },
        { model: Customer,      as: 'customer' },
      ],
      transaction,
    });

    if (!order) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Orden no encontrada' }); }
    if (order.sale_id) { await transaction.rollback(); return res.status(400).json({ success: false, message: 'Esta OT ya tiene un documento generado' }); }
    if (!['listo', 'entregado'].includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La OT debe estar en estado "listo" para generar el documento' });
    }
    if (!order.items || order.items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La OT no tiene ítems' });
    }

    // Tipo de documento: factura o remisión (el frontend pregunta al usuario)
    const { document_type = 'remision' } = req.body;
    if (!['factura', 'remision'].includes(document_type)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'document_type debe ser "factura" o "remision"' });
    }

    // Número del documento
    const year   = new Date().getFullYear();
    let sale_number;
    if (document_type === 'factura') {
      // Usar resolución DIAN activa del tenant
      const { DianResolution } = require('../../models');
      const resolution = await DianResolution.findOne({
        where: { tenant_id, branch_id: req.branch_id || null, is_active: true, document_type: 'invoice' },
        order: [['created_at', 'DESC']],
        transaction,
      });
      if (!resolution) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'No hay resolución DIAN activa para generar facturas. Configure la resolución en ajustes DIAN.' });
      }
      const nextNum = parseInt(resolution.current_number || resolution.from_number) + 1;
      sale_number = `${resolution.prefix || ''}${String(nextNum).padStart(5, '0')}`;
      await resolution.update({ current_number: nextNum }, { transaction });
    } else {
      const prefix = 'REM';
      const lastSale = await Sale.findOne({
        where: { tenant_id, sale_number: { [Op.like]: `${prefix}-${year}-%` } },
        order: [['sale_number', 'DESC']],
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      const saleSeq = lastSale ? parseInt(lastSale.sale_number.split('-')[2], 10) + 1 : 1;
      sale_number = `${prefix}-${year}-${String(saleSeq).padStart(4, '0')}`;
    }

    const customer     = order.customer;
    const customerName = customer
      ? (customer.business_name || `${customer.first_name} ${customer.last_name}`)
      : 'Cliente General';
    // Método del último abono ya cobrado en la OT, si hubo alguno — usado por
    // generateSaleEntry para decidir caja vs bancos en el saldo ya pagado.
    const lastPayment = (order.payment_history || [])[order.payment_history?.length - 1];

    const sale = await Sale.create({
      tenant_id,
      branch_id: req.branch_id || null,
      sale_number,
      document_type,
      customer_id:      order.customer_id,
      customer_name:    customerName,
      customer_phone:   customer?.phone  || null,
      customer_email:   customer?.email  || null,
      vehicle_plate:    order.vehicle?.plate || null,
      vehicle_brand:    order.vehicle?.brand || null,
      vehicle_model:    order.vehicle?.model || null,
      vehicle_year:     order.vehicle?.year  || null,
      vehicle_color:    order.vehicle?.color || null,
      mileage:          order.mileage_in || null,
      warehouse_id:     order.warehouse_id,
      subtotal:         order.subtotal,
      tax_amount:       order.tax_amount,
      discount_amount:  order.discount_amount || 0,
      total_amount:     order.total_amount,
      // Una remisión/factura emitida desde una OT ya cerrada es un hecho
      // consumado — no hay un paso de "confirmar" posterior para estas
      // ventas, así que nace 'completed' (no 'pending') para que sí dispare
      // el asiento contable automático y aparezca en Salud Contable.
      status:           'completed',
      // Se trasladan los abonos ya cobrados DURANTE la reparación (vía
      // registerPayment de la OT) — antes quedaban en blanco acá, perdiendo
      // el rastro de lo ya cobrado frente a la factura/remisión final.
      paid_amount:      order.paid_amount || 0,
      payment_status:   order.payment_status || 'pending',
      payment_history:  order.payment_history || [],
      payment_method:   lastPayment?.method || null,
      dian_status:      document_type === 'factura' ? 'pending' : 'not_applicable',
      notes: `Generada desde OT ${order.order_number}${order.work_performed ? '. ' + order.work_performed : ''}`.trim(),
      created_by: req.user.id,
    }, { transaction });

    // Ítems de la venta + movimientos de inventario
    for (const item of order.items) {
      // Obtener costo actual del producto si es un producto con inventario
      let unit_cost = 0;
      let product = null;
      if (item.product_id) {
        product = await Product.findOne({ where: { id: item.product_id, tenant_id }, transaction });
        unit_cost = product?.average_cost || 0;
      }

      await SaleItem.create({
        tenant_id,
        sale_id:          sale.id,
        item_type:        mapWorkOrderItemTypeToSale(item.item_type),
        product_id:       item.product_id,
        product_name:     item.product_name,
        product_sku:      item.product_sku,
        quantity:         item.quantity,
        unit_price:       item.unit_price,
        unit_cost,
        discount_percentage: 0,
        discount_amount:  0,
        tax_percentage:   item.tax_percentage,
        tax_amount:       item.tax_amount,
        subtotal:         item.subtotal,
        total:            item.total,
        technician_id:    item.technician_id || null,
      }, { transaction });

      // Crear movimiento de salida de inventario
      if (product && product.track_inventory && item.product_id) {
        // Validar stock si no permite negativos
        if (!product.allow_negative_stock) {
          const disponible = parseFloat(product.current_stock || 0);
          const solicitado = parseFloat(item.quantity);
          if (disponible < solicitado) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              message: `Stock insuficiente para ${product.name}: disponible ${disponible}, solicitado ${solicitado}`
            });
          }
        }

        await createMovement({
          tenant_id,
          movement_type:   'salida',
          movement_reason: 'sale',
          reference_type:  'sale',
          reference_id:    sale.id,
          product_id:      item.product_id,
          warehouse_id:    order.warehouse_id || null,
          quantity:        item.quantity,
          unit_cost,
          user_id:         req.user.id,
          movement_date:   new Date().toISOString().split('T')[0],
          notes:           `Remisión ${sale_number} - OT ${order.order_number}`,
        }, transaction);
      }
    }

    // Vincular y cerrar OT
    await order.update({ sale_id: sale.id, status: 'entregado', delivered_at: new Date() }, { transaction });

    await transaction.commit();

    // Asiento contable en borrador (no bloqueante) — mismo patrón que
    // confirm() en sales.controller.js. Antes NUNCA se llamaba para ventas
    // generadas desde Taller (quedaban sin contabilizar).
    setImmediate(async () => {
      try {
        const { generateSaleEntry } = require('../../services/accounting/autoEntries.service');
        const saleForAccounting = await Sale.findByPk(sale.id, { include: [{ model: SaleItem, as: 'items' }] });
        await generateSaleEntry(saleForAccounting, saleForAccounting.items, tenant_id, req.user.id);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de venta ${sale.id} (OT ${order.id}): ${err.message}`);
      }
    });

    res.status(201).json({
      success: true,
      message: 'Remisión generada exitosamente',
      data: { sale_id: sale.id, sale_number: sale.sale_number, total_amount: sale.total_amount },
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error generando remisión desde OT:', error);
    res.status(500).json({ success: false, message: 'Error al generar la remisión' });
  }
};

// ── UPLOAD PHOTOS ─────────────────────────────────────────────────────────────

const uploadPhotos = async (req, res) => {
  try {
    const { phase } = req.params;
    if (!['in', 'out'].includes(phase))
      return res.status(400).json({ success: false, message: 'Fase inválida. Usa "in" o "out"' });

    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ success: false, message: 'No se recibieron archivos' });

    const useCloudinary =
      process.env.USE_CLOUDINARY === 'true' &&
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET;

    const newPhotos = [];

    for (const file of req.files) {
      if (useCloudinary) {
        const cloudinary = require('cloudinary').v2;
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key:    process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
        });
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: `workshop/${order.tenant_id}/${order.id}`, resource_type: 'image' },
            (err, r) => (err ? reject(err) : resolve(r))
          );
          stream.end(file.buffer);
        });
        newPhotos.push({ url: result.secure_url, public_id: result.public_id, caption: '' });
      } else {
        const path  = require('path');
        const fs    = require('fs');
        const dir   = path.join(__dirname, '../../../uploads/workshop');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = `wo-${Date.now()}-${file.originalname}`;
        fs.writeFileSync(path.join(dir, filename), file.buffer);
        newPhotos.push({ url: `/uploads/workshop/${filename}`, public_id: filename, caption: '' });
      }
    }

    const field    = phase === 'in' ? 'photos_in' : 'photos_out';
    const existing = order[field] || [];
    await order.update({ [field]: [...existing, ...newPhotos] });

    res.json({ success: true, message: `${newPhotos.length} foto(s) subida(s)`, data: newPhotos });
  } catch (error) {
    logger.error('Error subiendo fotos OT:', error);
    res.status(500).json({ success: false, message: 'Error al subir fotos' });
  }
};

// ── DELETE PHOTO ──────────────────────────────────────────────────────────────

const deletePhoto = async (req, res) => {
  try {
    const { phase, photoIndex } = req.params;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const field  = phase === 'in' ? 'photos_in' : 'photos_out';
    const photos = [...(order[field] || [])];
    const idx    = parseInt(photoIndex);
    if (idx < 0 || idx >= photos.length)
      return res.status(400).json({ success: false, message: 'Índice de foto inválido' });

    const removed = photos.splice(idx, 1)[0];

    if (removed.public_id && removed.url?.includes('cloudinary')) {
      const cloudinary = require('cloudinary').v2;
      await cloudinary.uploader.destroy(removed.public_id).catch(() => {});
    }

    await order.update({ [field]: photos });
    res.json({ success: true, message: 'Foto eliminada' });
  } catch (error) {
    logger.error('Error eliminando foto OT:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar foto' });
  }
};


// ── TECHNICIAN PRODUCTIVITY ───────────────────────────────────────────────────

const productivity = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { date_from, date_to } = req.query;

    const where = { tenant_id };
    if (date_from || date_to) {
      where.received_at = {};
      if (date_from) where.received_at[Op.gte] = new Date(date_from);
      if (date_to)   where.received_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }

    // Fetch all relevant orders with items and technician
    const orders = await WorkOrder.findAll({
      where,
      include: [
        { model: User,          as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
        { model: WorkOrderItem, as: 'items',       attributes: ['id', 'item_type', 'total', 'tax_amount'] },
      ],
    });

    // Group by technician
    const map = {};

    for (const o of orders) {
      const techId   = o.technician_id || '__unassigned__';
      const techName = o.technician
        ? `${o.technician.first_name} ${o.technician.last_name}`
        : 'Sin asignar';

      if (!map[techId]) {
        map[techId] = {
          technician_id:      techId === '__unassigned__' ? null : techId,
          technician_name:    techName,
          total_orders:       0,
          completed_orders:   0,
          in_progress_orders: 0,
          total_revenue:      0,  // solo mano de obra (servicios)
          labor_revenue:      0,
        };
      }

      const entry = map[techId];
      entry.total_orders += 1;
      if (o.status === 'entregado') entry.completed_orders += 1;
      if (['en_proceso', 'en_espera', 'listo'].includes(o.status)) entry.in_progress_orders += 1;

      for (const item of (o.items || [])) {
        const itemTotal = parseFloat(item.total || 0);
        if (['service', 'servicio', 'mano_obra'].includes(item.item_type)) {
          entry.labor_revenue += itemTotal;
          entry.total_revenue += itemTotal;
        }
        // productos/repuestos no se suman a la productividad
      }
    }

    const result = Object.values(map).sort((a, b) => b.total_revenue - a.total_revenue);

    res.json({ success: true, data: result, period: { date_from, date_to } });
  } catch (error) {
    logger.error('Error en productividad técnicos:', error);
    res.status(500).json({ success: false, message: 'Error al calcular productividad' });
  }
};


// ── PAGOS / ABONOS ───────────────────────────────────────────────────────────

// Registrar un abono/pago parcial sobre la OT (antes de generar la remisión final)
const registerPayment = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const userId = req.user.id;
    const { amount, payment_method, payment_date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    // SELECT FOR UPDATE: evita que dos pagos concurrentes lean el mismo paid_amount
    const order = await WorkOrder.findOne({
      where: { id, tenant_id },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!order) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }
    if (order.status === 'cancelado') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se puede registrar un pago en una OT cancelada' });
    }

    const total = parseFloat(order.total_amount || 0);
    const alreadyPaid = parseFloat(order.paid_amount || 0);
    const remaining = total - alreadyPaid;

    if (total > 0 && remaining <= 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Esta orden ya está pagada en su totalidad' });
    }

    // Cualquier pago (efectivo, tarjeta, transferencia, otro) requiere una
    // caja abierta en la sede activa — solo para tenants con Tesorería activa.
    let openSession = null;
    if (await isTreasuryEnabled(tenant_id)) {
      openSession = await getOpenSession(tenant_id, req.branch_id, transaction);
      if (!openSession) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'No hay una caja abierta en esta sede. Abre la caja antes de registrar pagos.' });
      }
    }

    // Si aún no hay total_amount definido (OT sin ítems cerrados), se acepta el abono tal cual;
    // si sí hay total, se limita el monto al saldo pendiente para evitar sobrepagos.
    const effectiveAmount = total > 0 ? Math.min(parseFloat(amount), remaining) : parseFloat(amount);
    const paid_amount = alreadyPaid + effectiveAmount;

    let payment_status = 'pending';
    if (total > 0 && paid_amount >= total) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    const payment_id = require('crypto').randomUUID();
    const effectiveMethod = payment_method || 'cash';
    const effectiveDate = payment_date || new Date();

    const { generateReceiptNumber } = require('../../services/finance/receiptNumber.service');
    const { Receipt } = require('../../models');
    const receipt_number = await generateReceiptNumber(tenant_id, transaction);
    await Receipt.create({
      tenant_id,
      branch_id: req.branch_id,
      receipt_number,
      source_type: 'work_order',
      source_id: order.id,
      payment_id,
      cash_session_id: openSession?.id || null,
      amount: effectiveAmount,
      method: effectiveMethod,
      payment_date: effectiveDate,
      reference: order.order_number,
      created_by: userId,
    }, { transaction });

    const payment_history = [...(order.payment_history || [])];
    payment_history.push({
      payment_id,
      date: effectiveDate,
      amount: effectiveAmount,
      method: effectiveMethod,
      user_id: userId,
      notes: notes || null,
      receipt_number,
      cash_session_id: openSession?.id || null,
      branch_id: req.branch_id,
    });

    await order.update(
      { paid_amount, payment_status, payment_history },
      { transaction }
    );

    await transaction.commit();

    // Asiento contable del abono (caja/bancos vs cartera), no bloqueante —
    // SOLO si esta OT ya tiene una venta/factura generada (order.sale_id).
    // Si todavía no la tiene, este abono NO debe contabilizarse aquí: no
    // existe cartera que reducir todavía (aún no hay asiento de venta), y
    // generateSale ya traslada este payment_history completo a la Sale —
    // ahí sí queda correctamente repartido pagado/pendiente en un solo
    // asiento. Generar un asiento acá adelantado duplicaría ese monto.
    if (order.sale_id) {
      setImmediate(async () => {
        try {
          const { generatePaymentEntry } = require('../../services/accounting/autoEntries.service');
          const sale = await Sale.findByPk(order.sale_id);
          if (sale) {
            await generatePaymentEntry(
              { payment_id, amount: effectiveAmount, method: effectiveMethod, date: effectiveDate },
              sale,
              tenant_id,
              userId
            );
          }
        } catch (err) {
          logger.warn(`[accounting] Error generando asiento de abono (OT ${id}): ${err.message}`);
        }
      });
    }

    const updatedOrder = await WorkOrder.findOne({
      where: { id, tenant_id },
      attributes: WO_SAFE_ATTRS,
      include: [
        { model: Vehicle,  as: 'vehicle',    attributes: ['id', 'plate', 'brand', 'model', 'year', 'color'] },
        { model: Customer, as: 'customer',   attributes: ['id', 'first_name', 'last_name', 'business_name', 'phone'] },
      ],
    });

    res.json({
      success: true,
      message: 'Pago registrado exitosamente',
      data: { order: updatedOrder, receipt_number, amount_applied: effectiveAmount, balance: total - paid_amount },
    });
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    logger.error('Error registrando pago de OT:', error);
    res.status(500).json({ success: false, message: 'Error registrando el pago' });
  }
};

// Historial de abonos de una OT
const getPaymentHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const order = await WorkOrder.findOne({
      where: { id, tenant_id },
      attributes: ['id', 'order_number', 'total_amount', 'paid_amount', 'payment_status', 'payment_history'],
    });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const balance = parseFloat(order.total_amount || 0) - parseFloat(order.paid_amount || 0);
    const paymentHistory = order.payment_history || [];

    // Enriquecer historial con nombre de usuario (una sola query)
    const userIds = [...new Set(paymentHistory.map(p => p.user_id).filter(Boolean))];
    const users = userIds.length > 0
      ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'first_name', 'last_name'] })
      : [];
    const usersMap = Object.fromEntries(users.map(u => [u.id, u]));

    const enrichedHistory = paymentHistory.map((payment) => {
      const user = payment.user_id ? usersMap[payment.user_id] : null;
      const userName = user ? `${user.first_name} ${user.last_name}`.trim() : 'Usuario desconocido';
      return { ...payment, user_name: userName };
    });

    res.json({
      success: true,
      data: {
        order_number: order.order_number,
        total_amount: parseFloat(order.total_amount || 0),
        paid_amount: parseFloat(order.paid_amount || 0),
        payment_status: order.payment_status,
        balance,
        payment_history: enrichedHistory,
      },
    });
  } catch (error) {
    logger.error('Error obteniendo historial de pagos de OT:', error);
    res.status(500).json({ success: false, message: 'Error obteniendo historial de pagos' });
  }
};

// ── PDF GENERATION ───────────────────────────────────────────────────────────
const { generatePaymentReceiptBuffer, generateIntakeFormBuffer, generateWorkOrderPDFBuffer } = require('../../services/workshopPdfService');
const whatsappService = require('../../services/whatsappService');

async function getOrderWithTenant(id, tenant_id) {
  const order = await WorkOrder.findOne({
    where: { id, tenant_id },
    include: [
      { model: Vehicle,       as: 'vehicle' },
      { model: Customer,      as: 'customer' },
      { model: User,          as: 'technician', attributes: ['id', 'first_name', 'last_name', 'phone'] },
      { model: WorkOrderItem, as: 'items',
        include: [
          { model: require('../../models/inventory/Product'), as: 'product', attributes: ['id', 'name', 'sku'] },
          ITEM_TECHNICIAN_INCLUDE,
        ] },
    ],
  });

  if (order) {
    // Inyectar checklist_in con raw query (Sequelize omite JSONB agregado post-migración)
    const rows = await sequelize.query(
      'SELECT checklist_in FROM work_orders WHERE id = :id',
      { replacements: { id }, type: sequelize.QueryTypes.SELECT }
    );
    const data = order.toJSON();
    data.checklist_in = rows[0]?.checklist_in || {};
    const tenant = await Tenant.findByPk(tenant_id, {
      attributes: ['id', 'company_name', 'tax_id', 'phone', 'address', 'email', 'logo_url', 'pdf_config', 'features'],
    });
    return { order: data, tenant };
  }

  const tenant = await Tenant.findByPk(tenant_id, {
    attributes: ['id', 'company_name', 'tax_id', 'phone', 'address', 'email', 'logo_url', 'pdf_config', 'features'],
  });
  return { order: null, tenant };
}

const generatePDF = async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.query; // 'intake' | 'receipt' | 'workorder'
    const tenant_id = req.user.tenant_id;

    const { order, tenant } = await getOrderWithTenant(id, tenant_id);
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    let pdfBuffer, filename;

    if (type === 'intake') {
      pdfBuffer = await generateIntakeFormBuffer(order, tenant);
      filename  = `ingreso-${order.order_number}.pdf`;
    } else if (type === 'receipt') {
      const paymentData = {
        amount:         parseFloat(req.query.amount || 0),
        method:         req.query.method || 'cash',
        notes:          req.query.notes  || '',
        date:           req.query.date   || new Date(),
        receipt_number: req.query.receipt_number || `REC-${Date.now().toString().slice(-6)}`,
      };
      pdfBuffer = await generatePaymentReceiptBuffer(order, tenant, paymentData);
      filename  = `recibo-${order.order_number}.pdf`;
    } else {
      pdfBuffer = await generateWorkOrderPDFBuffer(order, tenant);
      filename  = `OT-${order.order_number}.pdf`;
    }

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length':      pdfBuffer.length,
      'Cache-Control':       'no-store',
    });
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Error generando PDF taller:', error);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Error generando PDF' });
  }
};

// ── CHECKLIST INGRESO ────────────────────────────────────────────────────────
const updateChecklist = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    // Verificar que la OT existe y pertenece al tenant
    const order = await WorkOrder.findOne({ where: { id, tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const { expectedVersion, rest: checklistData } = popExpectedVersion(req.body);
    if (hasVersionConflict(order, expectedVersion)) {
      return res.status(409).json({
        success: false,
        message: 'La orden fue modificada por otro usuario mientras estabas sin conexión',
        data: order,
      });
    }

    // Raw SQL para evitar problemas de Sequelize con JSONB
    await sequelize.query(
      `UPDATE work_orders SET checklist_in = :data::jsonb WHERE id = :id AND tenant_id = :tenant_id`,
      {
        replacements: {
          data: JSON.stringify(checklistData),
          id,
          tenant_id,
        },
        type: sequelize.QueryTypes.UPDATE,
      }
    );

    res.json({ success: true, data: checklistData });
  } catch (error) {
    logger.error('Error actualizando checklist:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar checklist' });
  }
};

/**
 * Reporte general del taller — exportable
 */
const getReport = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { date_from, date_to, format = 'json' } = req.query;

    const where = { tenant_id };
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at[Op.gte] = new Date(date_from);
      if (date_to)   where.created_at[Op.lte] = new Date(date_to + 'T23:59:59');
    }

    const orders = await WorkOrder.findAll({
      where,
      attributes: WO_SAFE_ATTRS,
      include: [
        { model: User,          as: 'technician', attributes: ['id', 'first_name', 'last_name'] },
        { model: Customer,      as: 'customer',   attributes: ['id', 'first_name', 'last_name', 'business_name'] },
        { model: Vehicle,       as: 'vehicle',    attributes: ['id', 'plate', 'brand', 'model'] },
        { model: WorkOrderItem, as: 'items' },
      ],
      order: [['created_at', 'DESC']]
    });

    const rows = orders.map(o => {
      const laborTotal  = (o.items || []).filter(i => ['servicio','mano_obra'].includes(i.item_type)).reduce((s, i) => s + parseFloat(i.total || 0), 0);
      const partsTotal  = (o.items || []).filter(i => i.item_type === 'repuesto').reduce((s, i) => s + parseFloat(i.total || 0), 0);
      const customerName = o.customer ? (o.customer.business_name || `${o.customer.first_name} ${o.customer.last_name}`) : 'Sin cliente';
      const techName     = o.technician ? `${o.technician.first_name} ${o.technician.last_name}` : 'Sin asignar';
      const resolutionDays = o.delivered_at && o.created_at
        ? Math.round((new Date(o.delivered_at) - new Date(o.created_at)) / 86400000)
        : null;

      return {
        order_number:      o.order_number,
        status:            o.status,
        customer:          customerName,
        vehicle:           o.vehicle ? `${o.vehicle.brand || ''} ${o.vehicle.model || ''} - ${o.vehicle.plate}`.trim() : '',
        technician:        techName,
        created_at:        o.created_at ? new Date(o.created_at).toLocaleDateString('es-CO') : '',
        delivered_at:      o.delivered_at ? new Date(o.delivered_at).toLocaleDateString('es-CO') : '',
        resolution_days:   resolutionDays,
        labor_total:       laborTotal,
        parts_total:       partsTotal,
        total_amount:      parseFloat(o.total_amount || 0),
        work_performed:    o.work_performed || '',
      };
    });

    // Totales
    const summary = {
      total_orders:       rows.length,
      completed:          rows.filter(r => r.status === 'entregado').length,
      cancelled:          rows.filter(r => r.status === 'cancelado').length,
      in_progress:        rows.filter(r => !['entregado','cancelado'].includes(r.status)).length,
      total_labor:        rows.reduce((s, r) => s + r.labor_total, 0),
      total_parts:        rows.reduce((s, r) => s + r.parts_total, 0),
      total_revenue:      rows.reduce((s, r) => s + r.total_amount, 0),
      avg_resolution_days: (() => {
        const resolved = rows.filter(r => r.resolution_days !== null);
        return resolved.length ? Math.round(resolved.reduce((s, r) => s + r.resolution_days, 0) / resolved.length) : 0;
      })(),
    };

    res.json({ success: true, data: rows, summary, period: { date_from, date_to } });
  } catch (error) {
    logger.error('Error en reporte taller:', error);
    res.status(500).json({ success: false, message: 'Error al generar reporte del taller' });
  }
};

/**
 * POST /work-orders/:id/share-token
 * Genera (o devuelve el existente) token único para compartir la OT por WhatsApp.
 * Requiere autenticación (solo el taller puede generar el link).
 */
const generateShareToken = async (req, res) => {
  try {
    // Verificar que la OT existe y pertenece al tenant usando solo atributos seguros
    const order = await WorkOrder.findOne({
      where: { id: req.params.id, tenant_id: req.user.tenant_id },
      attributes: WO_SAFE_ATTRS,
      include: [
        { model: Customer, as: 'customer', attributes: ['first_name', 'phone', 'mobile'] },
      ],
    });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    // Usar raw query para leer/escribir share_token — la columna puede no existir en BD
    let token;
    try {
      const rows = await sequelize.query(
        'SELECT share_token FROM work_orders WHERE id = :id',
        { replacements: { id: req.params.id }, type: sequelize.QueryTypes.SELECT }
      );
      token = rows[0]?.share_token;
    } catch {
      // Columna no existe aún en la BD
      return res.status(503).json({
        success: false,
        message: 'La función de compartir OT requiere una actualización de la base de datos. Ejecuta el script de migración.',
      });
    }

    if (!token) {
      token = require('crypto').randomUUID();
      await sequelize.query(
        'UPDATE work_orders SET share_token = :token WHERE id = :id',
        { replacements: { token, id: req.params.id }, type: sequelize.QueryTypes.UPDATE }
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-app.vercel.app';
    const shareUrl = `${frontendUrl}/ot/${token}`;

    const whatsappText = encodeURIComponent(
      `Hola! Puedes consultar el estado de tu orden de trabajo ${order.order_number} aquí:\n${shareUrl}`
    );

    // Usar el teléfono del cliente registrado (mobile tiene prioridad sobre phone)
    const customerPhone = order.customer?.mobile || order.customer?.phone || '';
    const cleanPhone = customerPhone.replace(/\D/g, '');
    const whatsappUrl = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${whatsappText}`
      : `https://wa.me/?text=${whatsappText}`;

    res.json({
      success: true,
      data: { token, share_url: shareUrl, whatsapp_url: whatsappUrl },
    });
  } catch (error) {
    logger.error('Error generando share token:', error);
    res.status(500).json({ success: false, message: 'Error al generar enlace' });
  }
};

/**
 * GET /public/work-orders/:token
 * Endpoint PÚBLICO (sin autenticación) para que el cliente consulte su OT.
 */
const getPublicOrder = async (req, res) => {
  try {
    const { token } = req.params;

    // Primero buscar el ID de la OT por share_token con raw query (columna puede no existir)
    let orderId;
    try {
      const rows = await sequelize.query(
        'SELECT id FROM work_orders WHERE share_token = :token LIMIT 1',
        { replacements: { token }, type: sequelize.QueryTypes.SELECT }
      );
      orderId = rows[0]?.id;
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }

    if (!orderId) {
      return res.status(404).json({ success: false, message: 'Orden no encontrada o enlace inválido' });
    }

    const order = await WorkOrder.findOne({
      where: { id: orderId },
      attributes: WO_SAFE_ATTRS,
      include: [
        {
          model: Vehicle,
          as: 'vehicle',
          attributes: ['plate', 'brand', 'model', 'year', 'color', 'fuel_type'],
        },
        {
          model: Customer,
          as: 'customer',
          attributes: ['first_name', 'last_name', 'business_name', 'phone', 'mobile'],
        },
        {
          model: User,
          as: 'technician',
          attributes: ['first_name', 'last_name'],
        },
        {
          model: WorkOrderItem,
          as: 'items',
          attributes: ['item_type', 'product_name', 'product_sku', 'quantity', 'unit_price', 'total', 'approval_status'],
        },
      ],
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Orden no encontrada o enlace inválido' });
    }

    // Rondas de cotización de esta OT — la más reciente 'enviada' (si existe)
    // es la que el cliente puede responder; las 'respondida' se muestran
    // como historial de solo-lectura.
    const quoteRequests = await WorkOrderQuoteRequest.findAll({
      where: { work_order_id: orderId },
      order: [['sent_at', 'DESC']],
      include: [{
        model: WorkOrderItem,
        as: 'items',
        attributes: ['id', 'product_name', 'product_sku', 'quantity', 'unit_price', 'total', 'item_type', 'approval_status', 'rejection_reason'],
      }],
    });

    const activeQuoteRequest = quoteRequests.find(q => q.status === 'enviada');
    const respondedQuoteRequests = quoteRequests.filter(q => q.status === 'respondida');

    // Buscar datos del taller (tenant) para mostrar nombre y contacto
    const tenant = await Tenant.findByPk(order.tenant_id, {
      attributes: ['company_name', 'phone', 'email', 'address', 'logo_url', 'primary_color'],
    });

    // Retornar solo campos seguros para el cliente (sin notas internas, sin IDs)
    const publicData = {
      order_number: order.order_number,
      status: order.status,
      problem_description: order.problem_description,
      diagnosis: order.diagnosis,
      work_performed: order.work_performed,
      mileage_in: order.mileage_in,
      received_at: order.received_at,
      promised_at: order.promised_at,
      completed_at: order.completed_at,
      delivered_at: order.delivered_at,
      subtotal: order.subtotal,
      tax_amount: order.tax_amount,
      total_amount: order.total_amount,
      photos_in: order.photos_in || [],
      photos_out: order.photos_out || [],
      notes: order.notes,
      vehicle: order.vehicle,
      customer: order.customer ? {
        name: order.customer.business_name || `${order.customer.first_name} ${order.customer.last_name || ''}`.trim(),
      } : null,
      technician: order.technician ? `${order.technician.first_name} ${order.technician.last_name}` : null,
      // Solo los ítems ya confirmados (aprobado) — los pendientes de cotizar
      // se muestran aparte en active_quote_request, no acá.
      items: (order.items || [])
        .filter(i => (i.approval_status || 'aprobado') === 'aprobado')
        .map(i => ({
          item_type: i.item_type,
          product_name: i.product_name,
          product_sku: i.product_sku,
          quantity: parseFloat(i.quantity),
          unit_price: parseFloat(i.unit_price),
          total: parseFloat(i.total),
        })),
      active_quote_request: activeQuoteRequest ? {
        id: activeQuoteRequest.id,
        sent_at: activeQuoteRequest.sent_at,
        items: (activeQuoteRequest.items || []).map(i => ({
          id: i.id,
          item_type: i.item_type,
          product_name: i.product_name,
          product_sku: i.product_sku,
          quantity: parseFloat(i.quantity),
          unit_price: parseFloat(i.unit_price),
          total: parseFloat(i.total),
        })),
      } : null,
      quote_history: respondedQuoteRequests.map(q => ({
        id: q.id,
        sent_at: q.sent_at,
        responded_at: q.responded_at,
        approved_by_name: q.approved_by_name,
        items: (q.items || []).map(i => ({
          product_name: i.product_name,
          quantity: parseFloat(i.quantity),
          total: parseFloat(i.total),
          approval_status: i.approval_status,
          rejection_reason: i.rejection_reason,
        })),
      })),
      workshop: tenant ? {
        name: tenant.company_name,
        phone: tenant.phone,
        email: tenant.email,
        address: tenant.address,
        logo_url: tenant.logo_url,
        primary_color: tenant.primary_color || '#2563eb',
      } : null,
    };

    res.json({ success: true, data: publicData });
  } catch (error) {
    logger.error('Error en getPublicOrder:', error);
    res.status(500).json({ success: false, message: 'Error al obtener orden' });
  }
};

// Enviar enlace OT por WhatsApp (wa.me)
// Genera un enlace wa.me con el estado de la OT pre-cargado.
// El frontend lo abre; el usuario presiona Enviar en WhatsApp.
const sendWhatsApp = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    // Obtener o crear share token
    const rows = await sequelize.query(
      'SELECT share_token FROM work_orders WHERE id = :id AND tenant_id = :tenant_id',
      { replacements: { id, tenant_id }, type: sequelize.QueryTypes.SELECT }
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    let token = rows[0].share_token;
    if (!token) {
      token = require('crypto').randomUUID();
      await sequelize.query(
        'UPDATE work_orders SET share_token = :token WHERE id = :id',
        { replacements: { token, id }, type: sequelize.QueryTypes.UPDATE }
      );
    }

    // Datos del cliente y la orden
    const { order } = await getOrderWithTenant(id, tenant_id);
    const phone = order?.customer?.mobile || order?.customer?.phone;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'El cliente no tiene número de teléfono registrado.' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-app.vercel.app';
    const shareUrl = `${frontendUrl}/ot/${token}`;
    const message  = `Hola! Te compartimos el estado de tu Orden de Trabajo *${order.order_number}*.\nPuedes consultarla en tiempo real aquí:\n${shareUrl}`;

    // Genera enlace wa.me (no envía automáticamente)
    const result = await whatsappService.sendText(phone, message);

    logger.info(`[WhatsApp] wa.me OT ${order.order_number} generado para ${phone}`);
    res.json({
      success: true,
      waLink:   result.waLink,   // El frontend abre este enlace
      shareUrl,
      message: `Enlace listo para enviar a ${phone}. Haz clic en "Abrir WhatsApp".`,
    });
  } catch (error) {
    logger.error('[WhatsApp] Error generando enlace OT:', error.message, error.stack);
    res.status(500).json({ success: false, message: error.message || 'Error al generar enlace de WhatsApp' });
  }
}
module.exports = { list, getById, create, update, changeStatus, addItem, removeItem, generateSale, uploadPhotos, deletePhoto, productivity, generatePDF, updateChecklist, getReport, generateShareToken, getPublicOrder, sendWhatsApp, registerPayment, getPaymentHistory, sendQuoteRequest, applyApprovedItems, respondQuoteRequest };