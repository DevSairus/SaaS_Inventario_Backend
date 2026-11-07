const { 
  Transfer, 
  TransferItem, 
  Product, 
  Warehouse,
  Project,
  ProjectBomItem,
  User
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

/**
 * Valida que el usuario tenga autorización sobre la sede dueña de una bodega
 * antes de permitir que se disponga de su stock (enviar o recibir).
 *
 * - admin / super_admin: pueden operar cualquier sede del tenant (mismo
 *   criterio que branchMiddleware).
 * - Resto de roles: solo pueden operar la bodega si pertenece a la sede
 *   activa de su request (req.branch_id, resuelta por branchMiddleware).
 *
 * Devuelve null si está autorizado, o un objeto { status, message } listo
 * para responder si no lo está.
 */
const assertBranchOwnsWarehouse = async (req, warehouseId) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return null;

  if (!req.branch_id) {
    return { status: 403, message: 'Tu usuario no tiene una sede activa asignada.' };
  }

  const warehouse = await Warehouse.findOne({
    where: { id: warehouseId, tenant_id: req.user.tenant_id }
  });

  if (!warehouse) {
    return { status: 404, message: 'Bodega no encontrada' };
  }

  if (warehouse.branch_id !== req.branch_id) {
    return {
      status: 403,
      message: 'No tienes autorización para disponer del stock de una bodega de otra sede.'
    };
  }

  return null;
};

const generateTransferNumber = async (tenant_id, transaction = null) => {
  const year = new Date().getFullYear();
  const prefix = `TRANS-${year}-`;

  const lastTransfer = await Transfer.findOne({
    where: {
      tenant_id,
      transfer_number: { [Op.like]: `${prefix}%` }
    },
    order: [['transfer_number', 'DESC']],
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction: transaction || undefined
  });

  let nextNumber = 1;
  if (lastTransfer) {
    const lastNum = parseInt(lastTransfer.transfer_number.split('-').pop(), 10);
    if (!isNaN(lastNum)) nextNumber = lastNum + 1;
  }

  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

const getTransfers = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const {
      search = '',
      from_warehouse_id,
      to_warehouse_id,
      status,
      start_date,
      end_date,
      sort_by = 'transfer_date',
      sort_order = 'DESC',
      page = 1,
      limit = 10
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;
    const where = { tenant_id };
    if (req.query.project_id) where.project_id = req.query.project_id;

    if (search) {
      where[Op.or] = [
        { transfer_number: { [Op.iLike]: `%${search}%` } },
        { tracking_number: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (from_warehouse_id) where.from_warehouse_id = from_warehouse_id;
    if (to_warehouse_id) where.to_warehouse_id = to_warehouse_id;
    if (status) where.status = status;
    if (start_date) where.transfer_date = { [Op.gte]: start_date };
    if (end_date) where.transfer_date = { ...where.transfer_date, [Op.lte]: end_date };

    const { count, rows } = await Transfer.findAndCountAll({
      where,
      include: [
        {
          model: Warehouse,
          as: 'fromWarehouse',
          attributes: ['id', 'name', 'code']
        },
        {
          model: Warehouse,
          as: 'toWarehouse',
          attributes: ['id', 'name', 'code']
        },
        { model: Project, as: 'project', attributes: ['id', 'code', 'name'] }
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error en getTransfers:', error);
    res.status(500).json({ success: false, message: 'Error al obtener transferencias' });
  }
};

const getTransferById = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const transfer = await Transfer.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: TransferItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku', 'barcode']
            }
          ]
        },
        { model: Project, as: 'project', attributes: ['id', 'code', 'name'] },
        ...['creator', 'sender', 'receiver', 'closer'].map((as) => ({ model: User, as, attributes: ['id', 'first_name', 'last_name', 'email'] })),
        {
          model: Warehouse,
          as: 'fromWarehouse',
          attributes: ['id', 'name', 'code', 'address']
        },
        {
          model: Warehouse,
          as: 'toWarehouse',
          attributes: ['id', 'name', 'code', 'address']
        }
      ]
    });

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
    }

    res.json({ success: true, data: transfer });
  } catch (error) {
    console.error('Error en getTransferById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener transferencia' });
  }
};

const createTransfer = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const tenant_id = req.user.tenant_id;
    const { from_warehouse_id, to_warehouse_id, shipping_method, tracking_number, notes, items } = req.body;

    if (from_warehouse_id === to_warehouse_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'La bodega origen y destino no pueden ser la misma'
      });
    }

    // Validar bodegas
    const fromWarehouse = await Warehouse.findOne({ where: { id: from_warehouse_id, tenant_id } });
    const toWarehouse = await Warehouse.findOne({ where: { id: to_warehouse_id, tenant_id } });

    if (!fromWarehouse || !toWarehouse) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Bodega no encontrada' });
    }

    // Validar stock en bodega origen
    for (const item of items) {
      const product = await Product.findOne({
        where: { id: item.product_id, tenant_id }
      });

      if (!product) {
        await transaction.rollback();
        return res.status(404).json({
          success: false,
          message: `Producto ${item.product_id} no encontrado`
        });
      }

      if (parseFloat(product.available_stock) < parseFloat(item.quantity)) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Stock insuficiente para ${product.name}. Disponible: ${product.available_stock}`
        });
      }
    }

    const MAX_RETRIES = 5;
    let transfer;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const transfer_number = await generateTransferNumber(tenant_id, transaction);
      try {
        transfer = await Transfer.create({
          tenant_id,
          transfer_number,
          from_warehouse_id,
          to_warehouse_id,
          transfer_date: new Date(),
          shipping_method,
          tracking_number,
          notes,
          status: 'draft',
          // Traslado hacia o desde la bodega de una obra: queda del proyecto
          // (despacho o reintegro hecho desde Traslados, no desde el BOM).
          project_id: toWarehouse.project_id || fromWarehouse.project_id || null,
          created_by: req.user.id
        }, { transaction });
        break;
      } catch (uniqueErr) {
        if (
          uniqueErr.name === 'SequelizeUniqueConstraintError' &&
          uniqueErr.fields?.transfer_number &&
          attempt < MAX_RETRIES
        ) {
          continue;
        }
        throw uniqueErr;
      }
    }

    // Reintegro desde la bodega de una obra: sale al costo al que el material
    // está en esa bodega (no al promedio actual del producto), para que el
    // estado de resultados del proyecto descuente lo mismo que costó entregarlo.
    const siteCost = new Map();
    if (fromWarehouse.project_id) {
      const { getWarehouseBalance } = require('../../services/projects/projectStock.service');
      for (const b of await getWarehouseBalance(tenant_id, fromWarehouse.id, { transaction })) {
        if (b.quantity > 0) siteCost.set(b.product_id, Math.round((b.value / b.quantity) * 100) / 100);
      }
    }

    for (const item of items) {
      const product = await Product.findByPk(item.product_id, { transaction });
      
      await TransferItem.create({
        transfer_id: transfer.id,
        product_id: item.product_id,
        quantity_sent: item.quantity,
        unit_cost: siteCost.has(item.product_id) ? siteCost.get(item.product_id) : product.average_cost,
        notes: item.notes
      }, { transaction });
    }

    await transaction.commit();

    const transferComplete = await Transfer.findByPk(transfer.id, {
      include: [
        {
          model: TransferItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        },
        { model: Warehouse, as: 'fromWarehouse', attributes: ['id', 'name'] },
        { model: Warehouse, as: 'toWarehouse', attributes: ['id', 'name'] }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Transferencia creada en estado borrador',
      data: transferComplete
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en createTransfer:', error);
    res.status(500).json({ success: false, message: 'Error al crear transferencia' });
  }
};

const sendTransfer = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const { shipping_notes } = req.body;

    const transfer = await Transfer.findOne({
      where: { id, tenant_id },
      include: [{ model: TransferItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!transfer) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
    }

    if (transfer.status !== 'draft') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden enviar transferencias en estado borrador'
      });
    }

    // Solo la sede dueña de la bodega origen puede autorizar la salida del stock
    const authError = await assertBranchOwnsWarehouse(req, transfer.from_warehouse_id);
    if (authError) {
      await transaction.rollback();
      return res.status(authError.status).json({ success: false, message: authError.message });
    }

    const { createMovement } = require('./movements.controller');

    // REDUCE stock en bodega origen
    for (const item of transfer.items) {
      const product = item.product;
      
      // Generar movimiento de salida por transferencia
      await createMovement({
        tenant_id,
        movement_type: 'salida',
        movement_reason: 'transfer_send',
        product_id: item.product_id,
        warehouse_id: transfer.from_warehouse_id,
        quantity: item.quantity_sent,
        unit_cost: item.unit_cost,
        reference_type: 'transfer',
        reference_id: transfer.id,
        user_id: req.user.id,
        notes: `Transferencia ${transfer.transfer_number} - Enviado a bodega destino`
      }, transaction);

      // Actualizar available_stock
      const updatedProduct = await Product.findByPk(item.product_id, { transaction });
      if (updatedProduct) {
        await updatedProduct.update({
          available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
        }, { transaction });
      }
    }

    await transfer.update({
      status: 'sent',
      sent_date: new Date(),
      sent_by: req.user.id,
      shipping_notes
    }, { transaction });

    await transaction.commit();

    res.json({ success: true, message: 'Transferencia enviada exitosamente', data: transfer });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en sendTransfer:', error);
    res.status(500).json({ success: false, message: 'Error al enviar transferencia' });
  }
};

const receiveTransfer = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const { receiving_notes, items } = req.body; // items: [{ product_id, quantity_received, condition }]

    const transfer = await Transfer.findOne({
      where: { id, tenant_id },
      include: [{ model: TransferItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!transfer) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
    }

    if (transfer.status !== 'sent') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden recibir transferencias enviadas'
      });
    }

    // Solo la sede dueña de la bodega destino puede confirmar la recepción del stock
    const authError = await assertBranchOwnsWarehouse(req, transfer.to_warehouse_id);
    if (authError) {
      await transaction.rollback();
      return res.status(authError.status).json({ success: false, message: authError.message });
    }

    const { createMovement } = require('./movements.controller');

    // Cantidad recibida de CADA línea. Antes `quantity_received || quantity_sent`
    // convertía un 0 en la cantidad completa, y las líneas que no venían en el
    // body (la pantalla omitía las de 0) quedaban sin registro. Sin `items`
    // en el body = se recibió todo lo enviado. Una línea se identifica por
    // item_id (un traslado puede llevar dos líneas del mismo producto) o, en
    // clientes viejos, por product_id.
    const received = new Map();
    if (Array.isArray(items)) {
      for (const ri of items) {
        const ti = transfer.items.find((x) => (ri.item_id ? x.id === ri.item_id : x.product_id === ri.product_id) && !received.has(x.id));
        if (!ti) continue;
        const raw = ri.quantity_received;
        const q = raw === undefined || raw === null || raw === '' ? parseFloat(ti.quantity_sent) : Number(raw);
        if (!Number.isFinite(q) || q < 0) {
          await transaction.rollback();
          return res.status(400).json({ success: false, message: `Cantidad recibida inválida para ${ti.product?.name || 'un producto'}` });
        }
        if (q > parseFloat(ti.quantity_sent) + 0.00005) {
          await transaction.rollback();
          return res.status(400).json({ success: false, message: `${ti.product?.name || 'Un producto'}: se enviaron ${parseFloat(ti.quantity_sent)}, no se pueden recibir ${q}` });
        }
        received.set(ti.id, q);
      }
    }
    const shortages = [];

    // INCREMENTA stock en bodega destino (ENT-TRAN)
    for (const transferItem of transfer.items) {
      const quantityReceived = Array.isArray(items) ? (received.get(transferItem.id) ?? 0) : parseFloat(transferItem.quantity_sent);
      const missing = Math.round((parseFloat(transferItem.quantity_sent) - quantityReceived) * 10000) / 10000;
      if (missing > 0) shortages.push({ product_id: transferItem.product_id, name: transferItem.product?.name, sku: transferItem.product?.sku, sent: parseFloat(transferItem.quantity_sent), received: quantityReceived, missing });

      await transferItem.update({ quantity_received: quantityReceived }, { transaction });

      // Despacho a una obra que llegó incompleto: lo que no llegó deja de
      // contar como despachado en la lista de materiales del proyecto.
      if (missing > 0 && transferItem.project_bom_item_id) {
        const line = await ProjectBomItem.findByPk(transferItem.project_bom_item_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (line) await line.update({ qty_dispatched: Math.max(parseFloat(line.qty_dispatched) - missing, 0) }, { transaction });
      }

      if (!(quantityReceived > 0)) continue;

      // Generar movimiento de entrada por transferencia
      await createMovement({
        tenant_id,
        movement_type: 'entrada',
        movement_reason: 'transfer_receive',
        product_id: transferItem.product_id,
        warehouse_id: transfer.to_warehouse_id,
        quantity: quantityReceived,
        unit_cost: transferItem.unit_cost,
        reference_type: 'transfer',
        reference_id: transfer.id,
        user_id: req.user.id,
        notes: `Transferencia ${transfer.transfer_number} - Recibido desde bodega origen`
      }, transaction);

      // Actualizar available_stock
      const updatedProduct = await Product.findByPk(transferItem.product_id, { transaction });
      if (updatedProduct) {
        await updatedProduct.update({
          available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
        }, { transaction });
      }
    }

    // Faltantes: el stock ya salió del origen al enviar, así que lo que no
    // llegó queda fuera del inventario; se deja constancia en las notas para
    // que se registre la pérdida (ajuste) o se reclame al transportador.
    const shortageNote = shortages.length
      ? `Faltantes al recibir: ${shortages.map((x) => `${x.sku || x.name} ${x.missing}`).join(', ')}`
      : null;
    await transfer.update({
      status: 'received',
      received_date: new Date(),
      received_by: req.user.id,
      receiving_notes: [receiving_notes, shortageNote].filter(Boolean).join(' · ') || null
    }, { transaction });

    await transaction.commit();

    const product_ids = transfer.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenant_id);

    res.json({
      success: true,
      message: shortages.length
        ? `Transferencia recibida con ${shortages.length} faltante(s). Registra la diferencia con un ajuste de inventario o reclámala antes de cerrar.`
        : 'Transferencia recibida exitosamente',
      data: { ...transfer.toJSON(), shortages },
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en receiveTransfer:', error);
    res.status(500).json({ success: false, message: 'Error al recibir transferencia' });
  }
};

const cancelTransfer = async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await transaction.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const { notes } = req.body;

    const transfer = await Transfer.findOne({
      where: { id, tenant_id },
      include: [{ model: TransferItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!transfer) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
    }

    if (transfer.status === 'received' || transfer.status === 'closed') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: transfer.status === 'closed' ? 'La transferencia está cerrada' : 'No se puede cancelar una transferencia ya recibida'
      });
    }
    if (transfer.status === 'cancelled') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La transferencia ya está cancelada' });
    }

    // Si ya fue enviada, devolver el stock a la bodega origen con un movimiento
    // de entrada (espejo de sendTransfer). Antes solo se sumaba a
    // product.current_stock: la bodega origen quedaba descuadrada y el kardex
    // no mostraba la devolución.
    if (transfer.status === 'sent') {
      const authError = await assertBranchOwnsWarehouse(req, transfer.from_warehouse_id);
      if (authError) {
        await transaction.rollback();
        return res.status(authError.status).json({ success: false, message: authError.message });
      }
      const { createMovement } = require('./movements.controller');
      for (const item of transfer.items) {
        await createMovement({
          tenant_id,
          movement_type: 'entrada',
          movement_reason: 'transfer_cancel',
          product_id: item.product_id,
          warehouse_id: transfer.from_warehouse_id,
          quantity: item.quantity_sent,
          unit_cost: item.unit_cost,
          reference_type: 'transfer',
          reference_id: transfer.id,
          user_id: req.user.id,
          notes: `Transferencia ${transfer.transfer_number} - Cancelada, stock devuelto a bodega origen`
        }, transaction);

        const updatedProduct = await Product.findByPk(item.product_id, { transaction });
        if (updatedProduct) {
          await updatedProduct.update({
            available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
          }, { transaction });
        }
      }
    }

    // Despacho de materiales de un proyecto: lo que iba hacia la obra vuelve a
    // quedar reservado en su línea del BOM (ver services/projects/projectBom.service.js).
    for (const item of transfer.items) {
      if (!item.project_bom_item_id) continue;
      const line = await ProjectBomItem.findByPk(item.project_bom_item_id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!line) continue;
      const qty = Math.min(parseFloat(item.quantity_sent) || 0, parseFloat(line.qty_dispatched) || 0);
      await line.update({
        qty_dispatched: parseFloat(line.qty_dispatched) - qty,
        qty_reserved: parseFloat(line.qty_reserved) + qty,
      }, { transaction });
    }

    await transfer.update({
      status: 'cancelled',
      notes: notes || transfer.notes
    }, { transaction });

    await transaction.commit();

    res.json({ success: true, message: 'Transferencia cancelada', data: transfer });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en cancelTransfer:', error);
    res.status(500).json({ success: false, message: 'Error al cancelar transferencia' });
  }
};

/**
 * Cierra un traslado recibido (remisión conciliada): queda bloqueado para
 * siempre y el evento en la auditoría. Si llegó distinto de lo enviado, hay
 * que explicar la diferencia. PUT /:id/close { notes }
 */
const closeTransfer = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const transfer = await Transfer.findOne({
      where: { id: req.params.id, tenant_id },
      include: [{ model: TransferItem, as: 'items', include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }] }]
    });
    if (!transfer) return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
    if (transfer.status === 'closed') return res.status(400).json({ success: false, message: 'La transferencia ya está cerrada' });
    if (transfer.status !== 'received') {
      return res.status(400).json({ success: false, message: 'Solo se cierra una transferencia recibida' });
    }
    const differences = transfer.items.filter((i) => Math.abs(parseFloat(i.quantity_sent) - parseFloat(i.quantity_received ?? i.quantity_sent)) > 0.00005);
    const notes = String(req.body?.notes || '').trim();
    if (differences.length && !notes) {
      return res.status(400).json({
        success: false,
        code: 'DIFFERENCES_NEED_NOTES',
        message: `Llegó distinto de lo enviado en ${differences.length} producto(s): explica la diferencia (ajuste registrado, reclamo, etc.) para cerrar.`,
        data: differences.map((i) => ({ name: i.product?.name, sku: i.product?.sku, sent: parseFloat(i.quantity_sent), received: parseFloat(i.quantity_received) })),
      });
    }
    await transfer.update({ status: 'closed', closed_at: new Date(), closed_by: req.user.id, closing_notes: notes || null });
    require('../../utils/audit')({
      tenant_id, user_id: req.user.id, action: 'close', entity: 'transfer', entity_id: transfer.id,
      changes: { transfer_number: transfer.transfer_number, differences: differences.length, notes: notes || null }, req,
    });
    res.json({ success: true, message: `Transferencia ${transfer.transfer_number} cerrada`, data: transfer });
  } catch (error) {
    console.error('Error en closeTransfer:', error);
    res.status(500).json({ success: false, message: 'Error al cerrar la transferencia' });
  }
};

const deleteTransfer = async (req, res) => {
  try {
    // ✅ Validar autenticación
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const transfer = await Transfer.findOne({ where: { id, tenant_id } });

    if (!transfer) {
      return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
    }

    if (transfer.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden eliminar transferencias en borrador'
      });
    }

    await transfer.destroy();

    res.json({ success: true, message: 'Transferencia eliminada exitosamente' });
  } catch (error) {
    console.error('Error en deleteTransfer:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar transferencia' });
  }
};

module.exports = {
  generateTransferNumber,
  assertBranchOwnsWarehouse,
  getTransfers,
  getTransferById,
  createTransfer,
  sendTransfer,
  receiveTransfer,
  cancelTransfer,
  closeTransfer,
  deleteTransfer
};