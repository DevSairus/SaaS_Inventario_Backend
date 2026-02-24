// backend/src/controllers/workshop/workOrders.controller.js
const logger = require('../../config/logger');
const { sequelize } = require('../../config/database');
const {
  WorkOrder, WorkOrderItem, Vehicle, Customer, User,
  Warehouse, Product, InventoryMovement, Sale, SaleItem,
} = require('../../models');
const { Op } = require('sequelize');
const { createMovement } = require('../inventory/movements.controller');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function generateOrderNumber(tenant_id, transaction) {
  const year   = new Date().getFullYear();
  const prefix = `OT-${year}-`;
  const last   = await WorkOrder.findOne({
    where: { tenant_id, order_number: { [Op.like]: `${prefix}%` } },
    order: [['created_at', 'DESC']],
    transaction,
  });
  const seq = last ? parseInt(last.order_number.replace(prefix, '')) + 1 : 1;
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

function calcTotals(items) {
  const subtotal   = items.reduce((s, i) => s + parseFloat(i.subtotal   || 0), 0);
  const tax_amount = items.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
  return { subtotal, tax_amount, total_amount: subtotal + tax_amount };
}

// ── LIST ─────────────────────────────────────────────────────────────────────

const list = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { status, technician_id, customer_id, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const where = { tenant_id };
    if (status)        where.status        = status;
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
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku', 'current_stock', 'product_type'] }],
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

    const {
      technician_id, warehouse_id, promised_at,
      problem_description, diagnosis, work_performed,
      notes, mileage_in, mileage_out, discount_amount,
    } = req.body;

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
  try {
    const { status, mileage_out } = req.body;
    const validStatuses = ['recibido', 'en_proceso', 'en_espera', 'listo', 'entregado', 'cancelado'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, message: 'Estado inválido' });

    const order = await WorkOrder.findOne({ where: { id: req.params.id, tenant_id: req.user.tenant_id } });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });

    const updates = { status };
    if (status === 'listo')     updates.completed_at = new Date();
    if (status === 'entregado') {
      updates.delivered_at = new Date();
      if (mileage_out) updates.mileage_out = mileage_out;
    }

    await order.update(updates);
    res.json({ success: true, message: `Estado actualizado a: ${status}`, data: order });
  } catch (error) {
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

    const { product_id, item_type, quantity, unit_price, tax_percentage } = req.body;
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

    // Validar stock si es repuesto físico
    const qty = parseFloat(quantity);
    if (item_type === 'repuesto' && product.track_inventory && parseFloat(product.current_stock) < qty) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: `Stock insuficiente. Disponible: ${product.current_stock}` });
    }

    // Calcular importes
    const price    = parseFloat(unit_price) || parseFloat(product.base_price) || 0;
    const taxPct   = parseFloat(tax_percentage ?? product.tax_percentage ?? 19);
    const subtotal = qty * price;
    const tax_amount = (product.has_tax !== false) ? Math.round(subtotal * (taxPct / 100)) : 0;
    const total    = subtotal + tax_amount;

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
    }, { transaction });

    // Descontar inventario si es repuesto físico con track_inventory
    if (item_type === 'repuesto' && product.track_inventory) {
      if (!order.warehouse_id) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'La OT debe tener una bodega asignada para descontar repuestos' });
      }

      const previous_stock = parseFloat(product.current_stock) || 0;
      const new_stock      = previous_stock - qty;
      const unit_cost_val  =
        parseFloat(product.average_cost) ||
        parseFloat(product.purchase_price) ||
        price;

      const movement_number = await generateMovementNumber(tenant_id, transaction);

      await product.update({ current_stock: new_stock }, { transaction });

      const movement = await InventoryMovement.create({
        tenant_id,
        movement_number,
        movement_type:   'salida',
        movement_reason: 'taller_repuesto',
        reference_type:  'work_order',
        reference_id:    order.id,
        product_id,
        warehouse_id:    order.warehouse_id,
        quantity:        qty,
        unit_cost:       unit_cost_val,
        total_cost:      qty * unit_cost_val,
        previous_stock,
        new_stock,
        user_id:         req.user.id,
        movement_date:   new Date(),
        notes:           `Repuesto OT ${order.order_number}: ${product.name}`,
      }, { transaction });

      await item.update({ inventory_movement_id: movement.id }, { transaction });
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
    if (order.sale_id) { await transaction.rollback(); return res.status(400).json({ success: false, message: 'Esta OT ya tiene una remisión generada' }); }
    if (!['listo', 'entregado'].includes(order.status)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La OT debe estar en estado "listo" para generar la remisión' });
    }
    if (!order.items || order.items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La OT no tiene ítems' });
    }

    // Número de remisión
    const year   = new Date().getFullYear();
    const prefix = `REM-${year}-`;
    const lastSale = await Sale.findOne({
      where: { tenant_id, sale_number: { [Op.like]: `${prefix}%` } },
      order: [['created_at', 'DESC']],
      transaction,
    });
    const saleSeq    = lastSale ? parseInt(lastSale.sale_number.replace(prefix, '')) + 1 : 1;
    const sale_number = `${prefix}${String(saleSeq).padStart(4, '0')}`;

    const customer     = order.customer;
    const customerName = customer
      ? (customer.business_name || `${customer.first_name} ${customer.last_name}`)
      : 'Cliente General';

    const sale = await Sale.create({
      tenant_id,
      sale_number,
      document_type:    'remision',
      customer_id:      order.customer_id,
      customer_name:    customerName,
      customer_phone:   customer?.phone  || null,
      customer_email:   customer?.email  || null,
      vehicle_plate:    order.vehicle?.plate || null,
      mileage:          order.mileage_out || order.mileage_in || null,
      warehouse_id:     order.warehouse_id,
      subtotal:         order.subtotal,
      tax_amount:       order.tax_amount,
      discount_amount:  order.discount_amount || 0,
      total_amount:     order.total_amount,
      status:           'pending',
      payment_status:   'pending',
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


// ── PDF GENERATION ───────────────────────────────────────────────────────────
const { generatePaymentReceipt, generateIntakeForm, generateWorkOrderPDF } = require('../../services/workshopPdfService');
const Tenant = require('../../models/auth/Tenant');

async function getOrderWithTenant(id, tenant_id) {
  const order = await WorkOrder.findOne({
    where: { id, tenant_id },
    include: [
      { model: Vehicle,       as: 'vehicle' },
      { model: Customer,      as: 'customer' },
      { model: User,          as: 'technician', attributes: ['id', 'first_name', 'last_name', 'phone'] },
      { model: WorkOrderItem, as: 'items',
        include: [{ model: require('../../models/inventory/Product'), as: 'product', attributes: ['id', 'name', 'sku'] }] },
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

    if (type === 'intake') {
      return generateIntakeForm(res, order, tenant);
    }
    if (type === 'receipt') {
      // Datos del pago vienen en query params para recibo rápido del último pago
      const paymentData = {
        amount:          parseFloat(req.query.amount || 0),
        method:          req.query.method || 'cash',
        notes:           req.query.notes  || '',
        date:            req.query.date   || new Date(),
        receipt_number:  req.query.receipt_number || `REC-${Date.now().toString().slice(-6)}`,
      };
      return generatePaymentReceipt(res, order, tenant, paymentData);
    }
    // default: OT completa
    return generateWorkOrderPDF(res, order, tenant);
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

    // Raw SQL para evitar problemas de Sequelize con JSONB
    await sequelize.query(
      `UPDATE work_orders SET checklist_in = :data::jsonb WHERE id = :id AND tenant_id = :tenant_id`,
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

module.exports = { list, getById, create, update, changeStatus, addItem, removeItem, generateSale, uploadPhotos, deletePhoto, productivity, generatePDF, updateChecklist };