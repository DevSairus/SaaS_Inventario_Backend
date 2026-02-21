const { 
  Transfer, 
  TransferItem, 
  Product, 
  Warehouse 
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

const generateTransferNumber = async (tenant_id) => {
  const year = new Date().getFullYear();
  const prefix = `TRANS-${year}-`;
  
  const lastTransfer = await Transfer.findOne({
    where: {
      tenant_id,
      transfer_number: { [Op.like]: `${prefix}%` }
    },
    order: [['created_at', 'DESC']]
  });

  let nextNumber = 1;
  if (lastTransfer) {
    const lastNum = parseInt(lastTransfer.transfer_number.split('-').pop());
    nextNumber = lastNum + 1;
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
        }
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

    const transfer_number = await generateTransferNumber(tenant_id);

    const transfer = await Transfer.create({
      tenant_id,
      transfer_number,
      from_warehouse_id,
      to_warehouse_id,
      transfer_date: new Date(),
      shipping_method,
      tracking_number,
      notes,
      status: 'draft',
      created_by: req.user.id
    }, { transaction });

    for (const item of items) {
      const product = await Product.findByPk(item.product_id);
      
      await TransferItem.create({
        transfer_id: transfer.id,
        product_id: item.product_id,
        quantity_sent: item.quantity,
        unit_cost: product.average_cost,
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

    const { createMovement } = require('./movements.controller');

    // INCREMENTA stock en bodega destino (ENT-TRAN)
    for (const receivedItem of items) {
      const transferItem = transfer.items.find(ti => ti.product_id === receivedItem.product_id);
      
      if (!transferItem) continue;

      const product = transferItem.product;
      const quantityReceived = parseFloat(receivedItem.quantity_received || transferItem.quantity_sent);

      // Actualizar item con cantidad recibida
      await transferItem.update({
        quantity_received: quantityReceived,
        condition: receivedItem.condition || 'good'
      }, { transaction });

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

    await transfer.update({
      status: 'received',
      received_date: new Date(),
      received_by: req.user.id,
      receiving_notes
    }, { transaction });

    await transaction.commit();

    const product_ids = transfer.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenantId);

    res.json({ success: true, message: 'Transferencia recibida exitosamente', data: transfer });
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

    if (transfer.status === 'received') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'No se puede cancelar una transferencia ya recibida'
      });
    }

    // Si ya fue enviada, devolver stock a bodega origen
    if (transfer.status === 'sent') {
      for (const item of transfer.items) {
        const product = item.product;
        const newStock = parseFloat(product.current_stock) + parseFloat(item.quantity_sent);
        
        await product.update({
          current_stock: newStock,
          available_stock: newStock - parseFloat(product.reserved_stock)
        }, { transaction });
      }
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
  getTransfers,
  getTransferById,
  createTransfer,
  sendTransfer,
  receiveTransfer,
  cancelTransfer,
  deleteTransfer
};