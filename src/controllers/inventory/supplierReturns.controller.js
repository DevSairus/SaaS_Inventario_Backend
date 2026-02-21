const { 
  SupplierReturn, 
  SupplierReturnItem, 
  Purchase, 
  PurchaseItem, 
  Product, 
  Supplier 
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

const generateReturnNumber = async (tenant_id) => {
  const year = new Date().getFullYear();
  const prefix = `DEVP-${year}-`;
  
  const lastReturn = await SupplierReturn.findOne({
    where: {
      tenant_id,
      return_number: { [Op.like]: `${prefix}%` }
    },
    order: [['created_at', 'DESC']]
  });

  let nextNumber = 1;
  if (lastReturn) {
    const lastNum = parseInt(lastReturn.return_number.split('-').pop());
    nextNumber = lastNum + 1;
  }

  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

const getSupplierReturns = async (req, res) => {
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
      supplier_id,
      status,
      start_date,
      end_date,
      sort_by = 'return_date',
      sort_order = 'DESC',
      page = 1,
      limit = 10
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { return_number: { [Op.iLike]: `%${search}%` } },
        { notes: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (supplier_id) where.supplier_id = supplier_id;
    if (status) where.status = status;
    if (start_date) where.return_date = { [Op.gte]: start_date };
    if (end_date) where.return_date = { ...where.return_date, [Op.lte]: end_date };

    const { count, rows } = await SupplierReturn.findAndCountAll({
      where,
      include: [
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name', 'email', 'phone']
        },
        {
          model: Purchase,
          as: 'purchase',
          attributes: ['id', 'purchase_number', 'purchase_date']
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
    console.error('Error en getSupplierReturns:', error);
    res.status(500).json({ success: false, message: 'Error al obtener devoluciones' });
  }
};

const getSupplierReturnById = async (req, res) => {
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

    const supplierReturn = await SupplierReturn.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: SupplierReturnItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku', 'barcode']
            },
            {
              model: PurchaseItem,
              as: 'purchaseItem',
              attributes: ['id', 'quantity', 'unit_cost']
            }
          ]
        },
        {
          model: Supplier,
          as: 'supplier',
          attributes: ['id', 'name', 'business_name', 'email', 'phone']
        },
        {
          model: Purchase,
          as: 'purchase',
          attributes: ['id', 'purchase_number', 'purchase_date', 'total_amount']
        }
      ]
    });

    if (!supplierReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    res.json({ success: true, data: supplierReturn });
  } catch (error) {
    console.error('Error en getSupplierReturnById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener devolución' });
  }
};

const createSupplierReturn = async (req, res) => {
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
    const { purchase_id, reason, notes, items } = req.body;

    const purchase = await Purchase.findOne({
      where: { id: purchase_id, tenant_id },
      include: [{ model: PurchaseItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!purchase) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Compra no encontrada' });
    }

    // Validar items
    for (const item of items) {
      const purchaseItem = purchase.items.find(pi => pi.id === item.purchase_item_id);
      
      if (!purchaseItem) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: 'Producto no encontrado en la compra' });
      }

      if (parseFloat(item.quantity) > parseFloat(purchaseItem.quantity)) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Cantidad a devolver excede la cantidad comprada`
        });
      }
    }

    let subtotal = 0;
    let tax = 0;

    const returnItems = items.map(item => {
      const purchaseItem = purchase.items.find(pi => pi.id === item.purchase_item_id);
      const itemSubtotal = parseFloat(item.quantity) * parseFloat(purchaseItem.unit_cost);
      const itemTax = itemSubtotal * (parseFloat(purchaseItem.tax_rate || 0) / 100);
      
      subtotal += itemSubtotal;
      tax += itemTax;

      return {
        purchase_item_id: item.purchase_item_id,
        product_id: purchaseItem.product_id,
        quantity: item.quantity,
        unit_cost: purchaseItem.unit_cost,
        subtotal: itemSubtotal,
        tax: itemTax,
        total: itemSubtotal + itemTax
      };
    });

    const total_amount = subtotal + tax;
    const return_number = await generateReturnNumber(tenant_id);

    const supplierReturn = await SupplierReturn.create({
      tenant_id,
      return_number,
      purchase_id,
      supplier_id: purchase.supplier_id,
      return_date: new Date(),
      reason,
      notes,
      subtotal,
      tax,
      total_amount,
      status: 'pending',
      created_by: req.user.id
    }, { transaction });

    for (const item of returnItems) {
      await SupplierReturnItem.create({
        return_id: supplierReturn.id,
        ...item
      }, { transaction });
    }

    const returnComplete = await SupplierReturn.findByPk(supplierReturn.id, {
      include: [
        {
          model: SupplierReturnItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        },
        { model: Supplier, as: 'supplier', attributes: ['id', 'name', 'business_name'] },
        { model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number'] }
      ],
      transaction
    });

    await transaction.commit();

    res.status(201).json({
      success: true,
      message: 'Devolución creada exitosamente. Pendiente de aprobación.',
      data: returnComplete
    });
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('Error en createSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al crear devolución' });
  }
};

const approveSupplierReturn = async (req, res) => {
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

    const supplierReturn = await SupplierReturn.findOne({
      where: { id, tenant_id },
      include: [{ model: SupplierReturnItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!supplierReturn) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (supplierReturn.status !== 'pending') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'La devolución ya fue procesada' });
    }

    const { createMovement } = require('./movements.controller');

    // REDUCE stock (es devolución a proveedor)
    for (const item of supplierReturn.items) {
      const product = item.product;
      
      // Generar movimiento de salida por devolución a proveedor
      // La función createMovement actualiza automáticamente el current_stock
      await createMovement({
        tenant_id,
        movement_type: 'salida',
        movement_reason: 'supplier_return',
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        reference_type: 'supplier_return',
        reference_id: supplierReturn.id,
        user_id: req.user.id,
        notes: `Devolución a proveedor ${supplierReturn.return_number} - ${supplierReturn.reason}`
      }, transaction);

      // Obtener el producto actualizado y recalcular available_stock
      const updatedProduct = await Product.findByPk(item.product_id, { transaction });
      if (updatedProduct) {
        await updatedProduct.update({
          available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
        }, { transaction });
      }
    }

    await supplierReturn.update({
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date()
    }, { transaction });

    await transaction.commit();

    const product_ids = supplierReturn.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenantId);

    res.json({ success: true, message: 'Devolución aprobada exitosamente', data: supplierReturn });
  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('Error en approveSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al aprobar devolución' });
  }
};

const rejectSupplierReturn = async (req, res) => {
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
    const { rejection_reason } = req.body;
    const tenant_id = req.user.tenant_id;

    const supplierReturn = await SupplierReturn.findOne({ where: { id, tenant_id } });

    if (!supplierReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (supplierReturn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'La devolución ya fue procesada' });
    }

    await supplierReturn.update({
      status: 'rejected',
      rejected_by: req.user.id,
      rejected_at: new Date(),
      rejection_reason
    });

    res.json({ success: true, message: 'Devolución rechazada', data: supplierReturn });
  } catch (error) {
    console.error('Error en rejectSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al rechazar devolución' });
  }
};

const deleteSupplierReturn = async (req, res) => {
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

    const supplierReturn = await SupplierReturn.findOne({ where: { id, tenant_id } });

    if (!supplierReturn) {
      return res.status(404).json({ success: false, message: 'Devolución no encontrada' });
    }

    if (supplierReturn.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Solo se pueden eliminar devoluciones pendientes' });
    }

    await supplierReturn.destroy();

    res.json({ success: true, message: 'Devolución eliminada exitosamente' });
  } catch (error) {
    console.error('Error en deleteSupplierReturn:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar devolución' });
  }
};

module.exports = {
  getSupplierReturns,
  getSupplierReturnById,
  createSupplierReturn,
  approveSupplierReturn,
  rejectSupplierReturn,
  deleteSupplierReturn
};