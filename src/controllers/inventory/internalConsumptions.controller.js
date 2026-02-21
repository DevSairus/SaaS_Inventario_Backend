const { 
  InternalConsumption, 
  InternalConsumptionItem, 
  Product, 
  Warehouse 
} = require('../../models');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

const generateConsumptionNumber = async (tenant_id) => {
  const year = new Date().getFullYear();
  const prefix = `CONS-${year}-`;
  
  const lastConsumption = await InternalConsumption.findOne({
    where: {
      tenant_id,
      consumption_number: { [Op.like]: `${prefix}%` }
    },
    order: [['created_at', 'DESC']]
  });

  let nextNumber = 1;
  if (lastConsumption) {
    const lastNum = parseInt(lastConsumption.consumption_number.split('-').pop());
    nextNumber = lastNum + 1;
  }

  return `${prefix}${String(nextNumber).padStart(5, '0')}`;
};

const getInternalConsumptions = async (req, res) => {
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
      warehouse_id,
      department,
      status,
      start_date,
      end_date,
      sort_by = 'consumption_date',
      sort_order = 'DESC',
      page = 1,
      limit = 10
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { consumption_number: { [Op.iLike]: `%${search}%` } },
        { department: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (warehouse_id) where.warehouse_id = warehouse_id;
    if (department) where.department = { [Op.iLike]: `%${department}%` };
    if (status) where.status = status;
    if (start_date) where.consumption_date = { [Op.gte]: start_date };
    if (end_date) where.consumption_date = { ...where.consumption_date, [Op.lte]: end_date };

    const { count, rows } = await InternalConsumption.findAndCountAll({
      where,
      include: [
        {
          model: Warehouse,
          as: 'warehouse',
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
    console.error('Error en getInternalConsumptions:', error);
    res.status(500).json({ success: false, message: 'Error al obtener consumos internos' });
  }
};

const getInternalConsumptionById = async (req, res) => {
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

    const consumption = await InternalConsumption.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: InternalConsumptionItem,
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
          as: 'warehouse',
          attributes: ['id', 'name', 'code', 'address']
        }
      ]
    });

    if (!consumption) {
      return res.status(404).json({ success: false, message: 'Consumo interno no encontrado' });
    }

    res.json({ success: true, data: consumption });
  } catch (error) {
    console.error('Error en getInternalConsumptionById:', error);
    res.status(500).json({ success: false, message: 'Error al obtener consumo interno' });
  }
};

const createInternalConsumption = async (req, res) => {
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
    const { warehouse_id, department, purpose, notes, items } = req.body;

    // Validar bodega
    const warehouse = await Warehouse.findOne({ where: { id: warehouse_id, tenant_id } });

    if (!warehouse) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Bodega no encontrada' });
    }

    // Validar productos y stock
    let total_cost = 0;

    const consumptionItems = [];
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

      const itemCost = parseFloat(item.quantity) * parseFloat(product.average_cost);
      total_cost += itemCost;

      consumptionItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: product.average_cost,
        total_cost: itemCost,
        notes: item.notes
      });
    }

    const consumption_number = await generateConsumptionNumber(tenant_id);

    const consumption = await InternalConsumption.create({
      tenant_id,
      consumption_number,
      warehouse_id,
      department,
      consumption_date: new Date(),
      purpose,
      notes,
      total_cost,
      status: 'pending',
      requested_by: req.user.id
    }, { transaction });

    for (const item of consumptionItems) {
      await InternalConsumptionItem.create({
        consumption_id: consumption.id,
        ...item
      }, { transaction });
    }

    await transaction.commit();

    const consumptionComplete = await InternalConsumption.findByPk(consumption.id, {
      include: [
        {
          model: InternalConsumptionItem,
          as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }]
        },
        { model: Warehouse, as: 'warehouse', attributes: ['id', 'name'] }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Consumo interno creado. Pendiente de aprobación.',
      data: consumptionComplete
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en createInternalConsumption:', error);
    res.status(500).json({ success: false, message: 'Error al crear consumo interno' });
  }
};

const approveInternalConsumption = async (req, res) => {
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

    const consumption = await InternalConsumption.findOne({
      where: { id, tenant_id },
      include: [{ model: InternalConsumptionItem, as: 'items', include: [{ model: Product, as: 'product' }] }]
    });

    if (!consumption) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Consumo interno no encontrado' });
    }

    if (consumption.status !== 'pending') {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El consumo ya fue procesado' });
    }

    const { createMovement } = require('./movements.controller');

    // REDUCE stock por consumo interno
    for (const item of consumption.items) {
      const product = item.product;
      
      // Generar movimiento de salida por consumo interno
      await createMovement({
        tenant_id,
        movement_type: 'salida',
        movement_reason: 'internal_consumption',
        product_id: item.product_id,
        warehouse_id: consumption.warehouse_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        reference_type: 'internal_consumption',
        reference_id: consumption.id,
        user_id: req.user.id,
        notes: `Consumo interno ${consumption.consumption_number} - Departamento: ${consumption.department}`
      }, transaction);

      // Actualizar available_stock
      const updatedProduct = await Product.findByPk(item.product_id, { transaction });
      if (updatedProduct) {
        await updatedProduct.update({
          available_stock: parseFloat(updatedProduct.current_stock) - parseFloat(updatedProduct.reserved_stock)
        }, { transaction });
      }
    }

    await consumption.update({
      status: 'approved',
      approved_by: req.user.id,
      approved_at: new Date()
    }, { transaction });

    await transaction.commit();

    const product_ids = consumption.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenantId);

    res.json({ success: true, message: 'Consumo interno aprobado exitosamente', data: consumption });
  } catch (error) {
    await transaction.rollback();
    console.error('Error en approveInternalConsumption:', error);
    res.status(500).json({ success: false, message: 'Error al aprobar consumo interno' });
  }
};

const rejectInternalConsumption = async (req, res) => {
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

    const consumption = await InternalConsumption.findOne({ where: { id, tenant_id } });

    if (!consumption) {
      return res.status(404).json({ success: false, message: 'Consumo interno no encontrado' });
    }

    if (consumption.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'El consumo ya fue procesado' });
    }

    await consumption.update({
      status: 'rejected',
      rejected_by: req.user.id,
      rejected_at: new Date(),
      rejection_reason
    });

    res.json({ success: true, message: 'Consumo interno rechazado', data: consumption });
  } catch (error) {
    console.error('Error en rejectInternalConsumption:', error);
    res.status(500).json({ success: false, message: 'Error al rechazar consumo interno' });
  }
};

const deleteInternalConsumption = async (req, res) => {
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

    const consumption = await InternalConsumption.findOne({ where: { id, tenant_id } });

    if (!consumption) {
      return res.status(404).json({ success: false, message: 'Consumo interno no encontrado' });
    }

    if (consumption.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden eliminar consumos pendientes'
      });
    }

    await consumption.destroy();

    res.json({ success: true, message: 'Consumo interno eliminado exitosamente' });
  } catch (error) {
    console.error('Error en deleteInternalConsumption:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar consumo interno' });
  }
};

module.exports = {
  getInternalConsumptions,
  getInternalConsumptionById,
  createInternalConsumption,
  approveInternalConsumption,
  rejectInternalConsumption,
  deleteInternalConsumption
};