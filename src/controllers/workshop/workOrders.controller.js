// backend/src/controllers/workshop/workOrders.controller.js
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const {
  WorkOrder, WorkOrderItem, WorkOrderQuoteRequest, Vehicle, Customer, User,
  Warehouse, Product, InventoryMovement, Sale, SaleItem,
  DiagramTemplate, WorkOrderDiagnosisMark,
} = require('../../models');
const { Op } = require('sequelize');
const { createMovement } = require('../inventory/movements.controller');
const Tenant = require('../../models/auth/Tenant');
const { getCurrentSchema, runWithTenantSchema } = require('../../config/tenantContext');

// Los endpoints PÚBLICOS (sin autenticación: getPublicOrder, respondQuoteRequest)
// no tienen tenantMiddleware -- nadie les setea el schema del tenant antes de
// llegar acá, porque no hay JWT del que sacarlo. share_token sí es un UUID
// único a nivel global, así que se puede resolver a qué schema pertenece
// probando primero "public" (tenants legado) y, si no aparece ahí, cada
// schema de un tenant ya cortado -- son pocos, y esto solo corre cuando un
// cliente abre el link de WhatsApp, no en cada request normal del taller.
async function resolveWorkOrderSchemaByToken(token) {
  const [publicRows] = await sequelize.query(
    'SELECT id FROM "public"."work_orders" WHERE share_token = :token LIMIT 1',
    { replacements: { token } }
  );
  if (publicRows[0]) return { orderId: publicRows[0].id, schemaName: null };

  const [tenants] = await sequelize.query(
    'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL'
  );
  for (const { schema_name } of tenants) {
    const [rows] = await sequelize.query(
      `SELECT id FROM "${schema_name}"."work_orders" WHERE share_token = :token LIMIT 1`,
      { replacements: { token } }
    );
    if (rows[0]) return { orderId: rows[0].id, schemaName: schema_name };
  }
  return null;
}

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

    // Sequelize puede no incluir columnas JSONB añadidas post-creación — forzar con raw query.
    // OJO: antes esto era `FROM work_orders` sin calificar schema -- siempre
    // resolvía contra "public", así que para tenants ya cortados esta fila
    // nunca existía ahí y checklist_in quedaba silenciosamente en {} (sin
    // error visible, la página cargaba igual con el resto de datos del ORM).
    const schema = getCurrentSchema() || 'public';
    const rows = await sequelize.query(
      `SELECT checklist_in FROM "${schema}"."work_orders" WHERE id = :id`,
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
    const sanitizedCustomerId = customer_id || null;

    // Si no viene bodega explícita, usar la bodega default de la sede activa
    // como respaldo (el frontend ya la precarga, pero esto protege contra
    // integraciones/clientes que no la envíen).
    let sanitizedWarehouseId = warehouse_id || null;
    if (!sanitizedWarehouseId && req.branch_id) {
      const branchWarehouse = await Warehouse.findOne({
        where: { branch_id: req.branch_id, tenant_id, is_active: true },
        order: [['is_default', 'DESC'], ['created_at', 'ASC']],
        transaction,
      });
      sanitizedWarehouseId = branchWarehouse?.id || null;
    }

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

    const {
      technician_id, warehouse_id, promised_at,
      problem_description, diagnosis, work_performed,
      notes, mileage_in, mileage_out, discount_amount,
      quality_checklist,
    } = req.body;

    await order.update({
      technician_id, warehouse_id, promised_at,
      problem_description, diagnosis, work_performed,
      notes, mileage_in, mileage_out,
      discount_amount: discount_amount != null ? parseFloat(discount_amount) : order.discount_amount,
      // Merge en vez de reemplazo: permite marcar un solo check (ej. "Limpieza
      // final") sin borrar los demás que ya estaban marcados.
      quality_checklist: quality_checklist
        ? { ...(order.quality_checklist || {}), ...quality_checklist }
        : order.quality_checklist,
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
    const { status, mileage_out } = req.body;
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

    const { product_id, item_type, quantity, unit_price, tax_percentage, technician_id: itemTechnicianId, requires_approval } = req.body;
    if (!product_id || !item_type || !quantity) {
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

    // Cotización con aprobación del cliente: no descuenta inventario todavía,
    // así que tampoco tiene sentido bloquear por stock insuficiente ahora
    // mismo — puede llegar a reponerse antes de que el cliente apruebe.
    const requiresApproval = requires_approval === true || requires_approval === 'true' || requires_approval === 1;

    // Validar stock si es repuesto físico
    const qty = parseFloat(quantity);
    if (!requiresApproval && item_type === 'repuesto' && product.track_inventory && parseFloat(product.current_stock) < qty) {
      const { getEquivalentsWithStock } = require('../../utils/equivalenceHelper');
      const alternatives = await getEquivalentsWithStock(product_id, tenant_id);
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `Stock insuficiente. Disponible: ${product.current_stock}`,
        alternatives
      });
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

// ── DIAGRAMAS INTERACTIVOS DE INTERVENCIÓN ──────────────────────────────────
// "Hoja de inspección" de la OT: el técnico elige un diagrama (vehicle_type +
// system + configuration), marca los puntos dañados y opcionalmente los
// puede convertir en WorkOrderItem — ver propuesta, secciones 2 y 2.5.

const DIAGNOSIS_MARK_INCLUDE = [
  { model: Product, as: 'suggested_product', attributes: ['id', 'name', 'sku', 'base_price'], required: false },
  { model: User, as: 'marked_by_user', attributes: ['id', 'first_name', 'last_name'], required: false },
  { model: DiagramTemplate, as: 'diagram_template', attributes: ['id', 'name', 'system', 'configuration'], required: false },
];

/**
 * GET /work-orders/:id/diagnosis-marks
 * Lista las marcas hechas sobre uno o varios diagramas para esta OT.
 */
const listDiagnosisMarks = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const marks = await WorkOrderDiagnosisMark.findAll({
      where: { work_order_id: order.id, tenant_id },
      include: DIAGNOSIS_MARK_INCLUDE,
      order: [['marked_at', 'ASC']],
    });

    res.json({ success: true, data: marks });
  } catch (error) {
    logger.error('Error listando marcas de diagnóstico:', error);
    res.status(500).json({ success: false, message: 'Error al obtener las marcas del diagrama' });
  }
};

/**
 * POST /work-orders/:id/diagnosis-marks
 * Registra un punto marcado por el técnico sobre un diagrama.
 */
const addDiagnosisMark = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    if (['entregado', 'cancelado'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'No se pueden agregar marcas a una OT cerrada' });
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

    const mark = await WorkOrderDiagnosisMark.create({
      tenant_id,
      work_order_id: order.id,
      diagram_template_id,
      point_number: parseInt(point_number),
      severity: severity || 'revisar',
      side: side || null,
      observation: observation || null,
      suggested_product_id: suggested_product_id || null,
      marked_by: req.user.id,
    });

    const full = await WorkOrderDiagnosisMark.findByPk(mark.id, { include: DIAGNOSIS_MARK_INCLUDE });
    res.status(201).json({ success: true, message: 'Marca registrada', data: full });
  } catch (error) {
    logger.error('Error agregando marca de diagnóstico:', error);
    res.status(500).json({ success: false, message: 'Error al registrar la marca' });
  }
};

/**
 * PUT /work-orders/:id/diagnosis-marks/:markId
 * Edita severidad/lado/observación/producto sugerido de una marca existente.
 */
const updateDiagnosisMark = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const mark = await WorkOrderDiagnosisMark.findOne({
      where: { id: req.params.markId, work_order_id: req.params.id, tenant_id },
    });
    if (!mark) return res.status(404).json({ success: false, message: 'Marca no encontrada' });
    if (mark.generated_item_id) {
      return res.status(400).json({ success: false, message: 'Esta marca ya generó un ítem y no se puede editar' });
    }

    const { severity, side, observation, suggested_product_id } = req.body;
    await mark.update({
      severity: severity || mark.severity,
      side: side !== undefined ? side : mark.side,
      observation: observation !== undefined ? observation : mark.observation,
      suggested_product_id: suggested_product_id !== undefined ? suggested_product_id : mark.suggested_product_id,
    });

    const full = await WorkOrderDiagnosisMark.findByPk(mark.id, { include: DIAGNOSIS_MARK_INCLUDE });
    res.json({ success: true, message: 'Marca actualizada', data: full });
  } catch (error) {
    logger.error('Error actualizando marca de diagnóstico:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la marca' });
  }
};

/**
 * DELETE /work-orders/:id/diagnosis-marks/:markId
 */
const removeDiagnosisMark = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const mark = await WorkOrderDiagnosisMark.findOne({
      where: { id: req.params.markId, work_order_id: req.params.id, tenant_id },
    });
    if (!mark) return res.status(404).json({ success: false, message: 'Marca no encontrada' });
    if (mark.generated_item_id) {
      return res.status(400).json({ success: false, message: 'Esta marca ya generó un ítem — elimina el ítem primero' });
    }

    await mark.destroy();
    res.json({ success: true, message: 'Marca eliminada' });
  } catch (error) {
    logger.error('Error eliminando marca de diagnóstico:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar la marca' });
  }
};

/**
 * POST /work-orders/:id/diagnosis-marks/generate-items
 * Convierte las marcas con producto sugerido (y que aún no generaron ítem)
 * en WorkOrderItem — el "reduce doble trabajo" de la sección 2.5.3. Los
 * ítems quedan 'pendiente' de aprobación del cliente, igual que cualquier
 * otro ítem agregado antes de una ronda de cotización.
 */
const generateItemsFromMarks = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const tenant_id = req.user.tenant_id;
    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id }, transaction });
    if (!order) { await transaction.rollback(); return res.status(404).json({ success: false, message: 'Orden no encontrada' }); }
    if (['entregado', 'cancelado'].includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No se pueden generar ítems en una OT cerrada' });
    }

    const { mark_ids } = req.body; // opcional: subset de marcas a convertir
    const where = { work_order_id: order.id, tenant_id, generated_item_id: null, suggested_product_id: { [Op.ne]: null } };
    if (Array.isArray(mark_ids) && mark_ids.length) where.id = { [Op.in]: mark_ids };

    const marks = await WorkOrderDiagnosisMark.findAll({ where, transaction });
    if (!marks.length) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'No hay marcas pendientes con producto sugerido para generar' });
    }

    const toBool = (v, def = false) => {
      if (v === true || v === 'true' || v === 1) return true;
      if (v === false || v === 'false' || v === 0) return false;
      return def;
    };

    const created = [];
    for (const mark of marks) {
      const product = await Product.findOne({ where: { id: mark.suggested_product_id, tenant_id }, transaction });
      if (!product) continue; // producto desactivado/borrado desde que se marcó — se omite, no se rompe el lote

      const qty   = 1;
      const price = parseFloat(product.base_price) || 0;
      const taxPct = parseFloat(product.tax_percentage ?? 19);
      const hasTax = toBool(product.has_tax, true) && taxPct > 0;
      const priceIncludesTax = toBool(product.price_includes_tax, false);

      let subtotal, tax_amount;
      if (!hasTax) {
        subtotal = qty * price; tax_amount = 0;
      } else if (priceIncludesTax) {
        const totalBruto = qty * price;
        subtotal = Math.round(totalBruto / (1 + taxPct / 100));
        tax_amount = totalBruto - subtotal;
      } else {
        subtotal = qty * price;
        tax_amount = Math.round(subtotal * (taxPct / 100));
      }

      const item_type = product.product_type === 'service' ? 'servicio' : 'repuesto';
      const item = await WorkOrderItem.create({
        tenant_id,
        work_order_id: order.id,
        item_type,
        product_id: product.id,
        product_name: product.name,
        product_sku: product.sku,
        quantity: qty,
        unit_price: price,
        tax_percentage: taxPct,
        tax_amount,
        subtotal,
        total: subtotal + tax_amount,
        approval_status: 'pendiente',
      }, { transaction });

      await mark.update({ generated_item_id: item.id }, { transaction });
      created.push(item);
    }

    // El ítem queda 'pendiente' (no facturable todavía), así que no se
    // recalculan totales de la OT aquí — se recalculan cuando el cliente
    // aprueba, igual que el resto del flujo de cotización.
    await transaction.commit();
    res.status(201).json({ success: true, message: `${created.length} ítem(s) generados desde el diagrama`, data: created });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error generando ítems desde marcas de diagnóstico:', error);
    res.status(500).json({ success: false, message: 'Error al generar los ítems' });
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

    // Reusar/crear share_token de la OT (mismo patrón que generateShareToken/sendWhatsApp).
    // `order` ya viene del ORM (schema-aware) -- evita el SQL crudo sin
    // calificar schema que antes siempre resolvía contra "public".
    let token = order.share_token;
    if (!token) {
      token = require('crypto').randomUUID();
      await order.update({ share_token: token }, { transaction });
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
  const { token, quoteRequestId } = req.params;
  const { approvals, approved_by_name, approved_by_document } = req.body;

  if (!approved_by_name || !approved_by_document) {
    return res.status(400).json({ success: false, message: 'Nombre y documento son requeridos para responder' });
  }
  if (!Array.isArray(approvals) || approvals.length === 0) {
    return res.status(400).json({ success: false, message: 'No se recibió ninguna decisión' });
  }

  // Resolver a qué schema pertenece esta OT ANTES de abrir la transacción --
  // mismo problema que getPublicOrder: sin esto, todo el resto asumía
  // "public" y nunca encontraba nada para un tenant ya cortado.
  let resolved;
  try {
    resolved = await resolveWorkOrderSchemaByToken(token);
  } catch {
    return res.status(503).json({ success: false, message: 'Función no disponible aún' });
  }
  if (!resolved) {
    return res.status(404).json({ success: false, message: 'Orden no encontrada o enlace inválido' });
  }

  return runWithTenantSchema(resolved.schemaName, () =>
    respondQuoteRequestBody({ orderId: resolved.orderId, quoteRequestId, approvals, approved_by_name, approved_by_document, req, res })
  );
};

async function respondQuoteRequestBody({ orderId, quoteRequestId, approvals, approved_by_name, approved_by_document, req, res }) {
  const transaction = await sequelize.transaction();
  try {
    const order = { id: orderId };

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
    logger.error('Error en respondQuoteRequestBody:', error);
    res.status(500).json({ success: false, message: 'Error al procesar la respuesta' });
  }
}

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
      status:           'pending',
      payment_status:   'pending',
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

    // Asiento contable en borrador (no bloqueante: si falla, solo se loguea).
    // Mismo patrón que sales.controller.js#update — antes de este fix, las
    // remisiones/facturas generadas desde el cierre de una OT nunca pasaban
    // por acá y quedaban sin asiento, descuadrando el libro diario contra
    // las ventas reales del taller.
    setImmediate(async () => {
      try {
        const { generateSaleEntry } = require('../../services/accounting/autoEntries.service');
        const finalSaleForAccounting = await Sale.findByPk(sale.id, { include: [{ model: SaleItem, as: 'items' }] });
        await generateSaleEntry(finalSaleForAccounting, finalSaleForAccounting.items, tenant_id, req.user.id);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento de venta ${sale.id} (desde cierre de OT ${order.id}): ${err.message}`);
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
            { folder: `workshop/${order.tenant_id}/${order.id}`, resource_type: 'auto' },
            (err, r) => (err ? reject(err) : resolve(r))
          );
          stream.end(file.buffer);
        });
        newPhotos.push({ url: result.secure_url, public_id: result.public_id, caption: '', type: file.mimetype?.startsWith('video') ? 'video' : 'image' });
      } else {
        const path  = require('path');
        const fs    = require('fs');
        const dir   = path.join(__dirname, '../../../uploads/workshop');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filename = `wo-${Date.now()}-${file.originalname}`;
        fs.writeFileSync(path.join(dir, filename), file.buffer);
        newPhotos.push({ url: `/uploads/workshop/${filename}`, public_id: filename, caption: '', type: file.mimetype?.startsWith('video') ? 'video' : 'image' });
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

    if (removed.url?.includes('cloudinary') && removed.public_id) {
      const cloudinary = require('cloudinary').v2;
      await cloudinary.uploader.destroy(removed.public_id).catch(() => {});
    } else if (removed.url?.startsWith('/uploads/')) {
      const path = require('path');
      const fs   = require('fs');
      const filePath = path.join(__dirname, '../../../', removed.url);
      fs.unlink(filePath, () => {}); // best-effort, no romper si falta
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

    // Si aún no hay total_amount definido (OT sin ítems cerrados), se acepta el abono tal cual;
    // si sí hay total, se limita el monto al saldo pendiente para evitar sobrepagos.
    const effectiveAmount = total > 0 ? Math.min(parseFloat(amount), remaining) : parseFloat(amount);
    const paid_amount = alreadyPaid + effectiveAmount;

    let payment_status = 'pending';
    if (total > 0 && paid_amount >= total) payment_status = 'paid';
    else if (paid_amount > 0) payment_status = 'partial';

    const receipt_number = `REC-${Date.now().toString().slice(-6)}`;
    const payment_history = [...(order.payment_history || [])];
    payment_history.push({
      date: payment_date || new Date(),
      amount: effectiveAmount,
      method: payment_method || 'cash',
      user_id: userId,
      notes: notes || null,
      receipt_number,
    });

    await order.update(
      { paid_amount, payment_status, payment_history },
      { transaction }
    );

    await transaction.commit();

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
  const { WorkOrderDiagnosisMark, DiagramTemplate } = require('../../models');
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
      { model: WorkOrderDiagnosisMark, as: 'diagnosis_marks',
        include: [{ model: DiagramTemplate, as: 'diagram_template' }],
      },
    ],
  });

  if (order) {
    // Inyectar checklist_in con raw query (Sequelize omite JSONB agregado post-migración)
    const schema = getCurrentSchema() || 'public';
    const rows = await sequelize.query(
      `SELECT checklist_in FROM "${schema}"."work_orders" WHERE id = :id`,
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

    // Raw SQL para evitar problemas de Sequelize con JSONB. OJO: antes esto
    // era `UPDATE work_orders` sin calificar schema -- para un tenant ya
    // cortado, el UPDATE afectaba 0 filas en "public" SIN error (una fila
    // que no matchea no es un fallo de SQL), así que el endpoint respondía
    // success:true pero el checklist nunca se guardaba de verdad.
    const schema = getCurrentSchema() || 'public';
    await sequelize.query(
      `UPDATE "${schema}"."work_orders" SET checklist_in = :data::jsonb WHERE id = :id AND tenant_id = :tenant_id`,
      {
        replacements: {
          data: JSON.stringify(req.body),
          id,
          tenant_id,
        },
        type: sequelize.QueryTypes.UPDATE,
      }
    );

    res.json({ success: true, data: req.body });
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

    // OJO: antes esto era SQL crudo sin calificar schema (`FROM work_orders`),
    // que siempre resolvía contra "public" sin importar el tenant -- para
    // tenants ya cortados a su propio schema, esa fila no existe ahí, así
    // que share_token nunca se leía ni se escribía de verdad (el endpoint
    // igual devolvía success:true con un token que no quedaba guardado en
    // ningún lado). Usar el `order` que ya trajo el ORM (schema-aware, ver
    // registerTenantSchemaHooks.js) evita el problema por completo.
    let token = order.share_token;
    if (!token) {
      token = require('crypto').randomUUID();
      await order.update({ share_token: token });
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

    // Resolver primero A QUÉ SCHEMA pertenece esta OT (ver
    // resolveWorkOrderSchemaByToken) -- sin esto, todo lo que sigue asumía
    // "public" a secas y nunca encontraba nada para un tenant ya cortado.
    let resolved;
    try {
      resolved = await resolveWorkOrderSchemaByToken(token);
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }

    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Orden no encontrada o enlace inválido' });
    }
    const { orderId, schemaName } = resolved;

    return runWithTenantSchema(schemaName, () => getPublicOrderBody(orderId, res));
  } catch (error) {
    logger.error('Error en getPublicOrder:', error);
    res.status(500).json({ success: false, message: 'Error al obtener orden' });
  }
};

// Cuerpo real de getPublicOrder, corriendo ya dentro del schema correcto
// (ver runWithTenantSchema arriba) -- todas las queries ORM de acá para
// abajo (WorkOrder, WorkOrderQuoteRequest, WorkOrderDiagnosisMark) resuelven
// solas contra ese schema vía el getter dinámico de registerTenantSchemaHooks.js.
async function getPublicOrderBody(orderId, res) {
  try {
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

    // Mapa de intervención — diagramas marcados por el técnico (fase 4 de la
    // propuesta de diagramas interactivos). Se agrupan por diagrama, con solo
    // los campos seguros: nada de suggested_product_id/generated_item_id/
    // marked_by, que son internos del taller.
    const diagnosisMarks = await WorkOrderDiagnosisMark.findAll({
      where: { work_order_id: orderId },
      include: [{
        model: DiagramTemplate,
        as: 'diagram_template',
        attributes: ['id', 'name', 'svg_content', 'image_path', 'view_box', 'points'],
      }],
      order: [['marked_at', 'ASC']],
    });

    const diagramsMap = new Map();
    for (const mark of diagnosisMarks) {
      const tpl = mark.diagram_template;
      if (!tpl) continue;
      if (!diagramsMap.has(tpl.id)) {
        diagramsMap.set(tpl.id, {
          id: tpl.id,
          name: tpl.name,
          svg_content: tpl.svg_content,
          image_path: tpl.image_path,
          view_box: tpl.view_box,
          points: tpl.points || [],
          marks: [],
        });
      }
      diagramsMap.get(tpl.id).marks.push({
        point_number: mark.point_number,
        severity: mark.severity,
        side: mark.side,
        observation: mark.observation,
      });
    }
    const diagrams = Array.from(diagramsMap.values());

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
      // Mapa de intervención — diagrama(s) con los puntos marcados por el
      // técnico, para que el cliente entienda visualmente de dónde salen
      // los ítems cotizados (ver propuesta, sección 3).
      diagrams,
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
    logger.error('Error en getPublicOrderBody:', error);
    res.status(500).json({ success: false, message: 'Error al obtener orden' });
  }
}

// Enviar enlace OT por WhatsApp (wa.me)
// Genera un enlace wa.me con el estado de la OT pre-cargado.
// El frontend lo abre; el usuario presiona Enviar en WhatsApp.
const sendWhatsApp = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    // Obtener o crear share token. OJO: antes esto era SQL crudo sin
    // calificar schema (`FROM work_orders`), que siempre resolvía contra
    // "public" -- para tenants ya cortados esa fila no existe ahí, así que
    // siempre daba "Orden no encontrada". El ORM (WorkOrder.findOne) sí es
    // schema-aware (ver registerTenantSchemaHooks.js).
    const wo = await WorkOrder.findOne({ where: { id, tenant_id } });
    if (!wo) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    let token = wo.share_token;
    if (!token) {
      token = require('crypto').randomUUID();
      await wo.update({ share_token: token });
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
module.exports = { list, getById, create, update, changeStatus, addItem, removeItem, generateSale, uploadPhotos, deletePhoto, productivity, generatePDF, updateChecklist, getReport, generateShareToken, getPublicOrder, sendWhatsApp, registerPayment, getPaymentHistory, sendQuoteRequest, applyApprovedItems, respondQuoteRequest, listDiagnosisMarks, addDiagnosisMark, updateDiagnosisMark, removeDiagnosisMark, generateItemsFromMarks };