const { 
  CustomerReturn, 
  CustomerReturnItem,
  Sale,
  SaleItem,
  Product,
  Customer 
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

/**
 * Generar número de devolución único
 */
const generateReturnNumber = async (tenant_id) => {
  const year = new Date().getFullYear();
  const prefix = `DEV-${year}-`;
  
  const lastReturn = await CustomerReturn.findOne({
    where: {
      tenant_id,
      return_number: {
        [Op.like]: `${prefix}%`
      }
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

/**
 * Obtener todas las devoluciones con filtros
 */
const getCustomerReturns = async (req, res) => {
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
      customer_id,
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

    // Construir condiciones
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { return_number: { [Op.iLike]: `%${search}%` } },
        { notes: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (customer_id) {
      where.customer_id = customer_id;
    }

    if (status) {
      where.status = status;
    }

    if (start_date) {
      where.return_date = {
        [Op.gte]: start_date
      };
    }

    if (end_date) {
      where.return_date = {
        ...where.return_date,
        [Op.lte]: end_date
      };
    }

    // Obtener devoluciones
    const { count, rows } = await CustomerReturn.findAndCountAll({
      where,
      include: [
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'customer_type', 'email', 'phone']
        },
        {
          model: Sale,
          as: 'sale',
          attributes: ['id', 'sale_number', 'sale_date']
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
    console.error('Error en getCustomerReturns:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener devoluciones'
    });
  }
};

/**
 * Obtener una devolución por ID
 */
const getCustomerReturnById = async (req, res) => {
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

    const customerReturn = await CustomerReturn.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: CustomerReturnItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku', 'barcode']
            },
            {
              model: SaleItem,
              as: 'saleItem',
              attributes: ['id', 'quantity', 'unit_price']
            }
          ]
        },
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'customer_type', 'email', 'phone', 'address']
        },
        {
          model: Sale,
          as: 'sale',
          attributes: ['id', 'sale_number', 'sale_date', 'total_amount']
        }
      ]
    });

    if (!customerReturn) {
      return res.status(404).json({
        success: false,
        message: 'Devolución no encontrada'
      });
    }

    res.json({
      success: true,
      data: customerReturn
    });

  } catch (error) {
    console.error('Error en getCustomerReturnById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener devolución'
    });
  }
};

/**
 * Crear nueva devolución de cliente
 */
const createCustomerReturn = async (req, res) => {
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
    const { sale_id, reason, notes, items } = req.body;

    console.log('📦 Datos recibidos para crear devolución:', { sale_id, reason, notes, items });

    // Validaciones iniciales
    if (!sale_id) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'El ID de la venta es requerido'
      });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Debe especificar al menos un producto para devolver'
      });
    }


    // 1. Validar que existe la venta
    const sale = await Sale.findOne({
      where: { id: sale_id, tenant_id },
      include: [
        { 
          model: SaleItem, 
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product'
            }
          ]
        }
      ]
    });

    if (!sale) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Venta no encontrada'
      });
    }

    // 2. Validar items a devolver
    for (const item of items) {
      const saleItem = sale.items.find(si => si.id === item.sale_item_id);
      
      if (!saleItem) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Producto no encontrado en la venta`
        });
      }

      // Verificar cantidad
      if (parseFloat(item.quantity) > parseFloat(saleItem.quantity)) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Cantidad a devolver (${item.quantity}) excede la cantidad vendida (${saleItem.quantity})`
        });
      }

      // Verificar que no se haya devuelto ya
      const alreadyReturned = await CustomerReturnItem.sum('quantity', {
        where: {
          sale_item_id: item.sale_item_id
        },
        transaction
      });

      const remainingToReturn = parseFloat(saleItem.quantity) - (parseFloat(alreadyReturned) || 0);
      
      if (parseFloat(item.quantity) > remainingToReturn) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `Solo puede devolver ${remainingToReturn} unidades de este producto`
        });
      }
    }

    // 3. Calcular totales
    let subtotal = 0;
    let tax = 0;

    const returnItems = items.map(item => {
      const saleItem = sale.items.find(si => si.id === item.sale_item_id);
      const itemSubtotal = parseFloat(item.quantity) * parseFloat(saleItem.unit_price);
      const itemTax = itemSubtotal * (parseFloat(saleItem.tax_rate || 0) / 100);
      
      subtotal += itemSubtotal;
      tax += itemTax;

      return {
        sale_item_id: item.sale_item_id,
        product_id: saleItem.product_id,
        quantity: item.quantity,
        unit_price: saleItem.unit_price,
        unit_cost: saleItem.unit_cost || saleItem.product.average_cost || 0,
        condition: item.condition || 'used',
        destination: item.condition === 'defective' ? 'quarantine' : 'inventory',
        subtotal: itemSubtotal,
        tax: itemTax,
        total: itemSubtotal + itemTax
      };
    });

    const total_amount = subtotal + tax;

    // 4. Generar número de devolución
    const return_number = await generateReturnNumber(tenant_id);

    // 5. Crear devolución
    const customerReturn = await CustomerReturn.create({
      tenant_id,
      return_number,
      sale_id,
      customer_id: sale.customer_id,
      return_date: new Date(),
      reason,
      notes,
      subtotal,
      tax,
      total_amount,
      status: 'pending', // Requiere aprobación
      created_by: req.user.id
    }, { transaction });

    // 6. Crear items
    for (const item of returnItems) {
      await CustomerReturnItem.create({
        return_id: customerReturn.id,
        ...item
      }, { transaction });
    }

    // 7. Obtener devolución completa dentro de la transacción
    const returnComplete = await CustomerReturn.findByPk(customerReturn.id, {
      include: [
        {
          model: CustomerReturnItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku']
            }
          ]
        },
        {
          model: Customer,
          as: 'customer',
          attributes: ['id', 'first_name', 'last_name', 'business_name', 'email']
        },
        {
          model: Sale,
          as: 'sale',
          attributes: ['id', 'sale_number']
        }
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
    console.error('Error en createCustomerReturn:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear devolución'});
  }
};

/**
 * Aprobar devolución (genera movimientos y actualiza stock)
 */
const approveCustomerReturn = async (req, res) => {
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

    const customerReturn = await CustomerReturn.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: CustomerReturnItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product'
            }
          ]
        }
      ]
    });

    if (!customerReturn) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Devolución no encontrada'
      });
    }

    if (customerReturn.status !== 'pending') {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `La devolución ya fue ${customerReturn.status === 'approved' ? 'aprobada' : 'rechazada'}`
      });
    }

    // 1. Actualizar stock y generar movimientos
    const { createMovement } = require('../inventory/movements.controller');

    for (const item of customerReturn.items) {
      const product = item.product;
      
      if (!product) continue;

      // Solo generar movimiento si el destino es inventario
      if (item.destination === 'inventory') {
        // Generar movimiento de entrada por devolución de cliente
        // La función createMovement actualiza automáticamente el current_stock
        await createMovement({
          tenant_id,
          movement_type: 'entrada',
          movement_reason: 'customer_return',
          product_id: item.product_id,
          quantity: item.quantity,
          unit_cost: item.unit_cost,
          reference_type: 'customer_return',
          reference_id: customerReturn.id,
          user_id: req.user.id,
          notes: `Devolución de cliente ${customerReturn.return_number} - ${customerReturn.reason}`
        }, transaction);

        // Obtener el producto actualizado y recalcular available_stock
        const updatedProduct = await Product.findByPk(item.product_id, { transaction });
        if (updatedProduct) {
          await updatedProduct.update({
            available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
          }, { transaction });
        }
      }
    }

    // 2. Actualizar estado
    await customerReturn.update({
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date()
    }, { transaction });

    await transaction.commit();

    const product_ids = supplierReturn.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenantId);

    res.json({
      success: true,
      message: 'Devolución aprobada exitosamente',
      data: customerReturn
    });

  } catch (error) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    console.error('Error en approveCustomerReturn:', error);
    res.status(500).json({
      success: false,
      message: 'Error al aprobar devolución'});
  }
};

/**
 * Rechazar devolución
 */
const rejectCustomerReturn = async (req, res) => {
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

    const customerReturn = await CustomerReturn.findOne({
      where: { id, tenant_id }
    });

    if (!customerReturn) {
      return res.status(404).json({
        success: false,
        message: 'Devolución no encontrada'
      });
    }

    if (customerReturn.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'La devolución ya fue procesada'
      });
    }

    await customerReturn.update({
      status: 'rejected',
      rejected_by: req.user.id,
      rejected_at: new Date(),
      rejection_reason
    });

    res.json({
      success: true,
      message: 'Devolución rechazada',
      data: customerReturn
    });

  } catch (error) {
    console.error('Error en rejectCustomerReturn:', error);
    res.status(500).json({
      success: false,
      message: 'Error al rechazar devolución'
    });
  }
};

/**
 * Eliminar devolución (solo si está en pending)
 */
const deleteCustomerReturn = async (req, res) => {
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

    const customerReturn = await CustomerReturn.findOne({
      where: { id, tenant_id }
    });

    if (!customerReturn) {
      return res.status(404).json({
        success: false,
        message: 'Devolución no encontrada'
      });
    }

    if (customerReturn.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden eliminar devoluciones pendientes'
      });
    }

    await customerReturn.destroy();

    res.json({
      success: true,
      message: 'Devolución eliminada exitosamente'
    });

  } catch (error) {
    console.error('Error en deleteCustomerReturn:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar devolución'
    });
  }
};

module.exports = {
  getCustomerReturns,
  getCustomerReturnById,
  createCustomerReturn,
  approveCustomerReturn,
  rejectCustomerReturn,
  deleteCustomerReturn
};