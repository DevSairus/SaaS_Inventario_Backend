const { InventoryAdjustment, InventoryAdjustmentItem, Product } = require('../../models/inventory');
const { createMovement } = require('./movements.controller');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');

/**
 * Obtener todos los ajustes con filtros y paginación
 */
const getAdjustments = async (req, res) => {
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
      adjustment_type,
      reason,
      status,
      start_date,
      end_date,
      sort_by = 'adjustment_date',
      sort_order = 'DESC',
      page = 1,
      limit = 10
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;

    // Construir condiciones de búsqueda
    const where = { tenant_id };

    if (adjustment_type) {
      where.adjustment_type = adjustment_type;
    }

    if (reason) {
      where.reason = { [Op.iLike]: `%${reason}%` };
    }

    if (status) {
      where.status = status;
    }

    if (start_date) {
      where.adjustment_date = {
        ...where.adjustment_date,
        [Op.gte]: start_date
      };
    }

    if (end_date) {
      where.adjustment_date = {
        ...where.adjustment_date,
        [Op.lte]: end_date
      };
    }

    if (search) {
      where[Op.or] = [
        { adjustment_number: { [Op.iLike]: `%${search}%` } },
        { notes: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // Obtener ajustes
    const { count, rows } = await InventoryAdjustment.findAndCountAll({
      where,
      include: [
        {
          model: InventoryAdjustmentItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku']
            }
          ]
        }
      ],
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Calcular totales para cada ajuste
    const adjustmentsWithTotals = rows.map(adjustment => {
      const adj = adjustment.toJSON();
      const totalQuantity = adj.items.reduce((sum, item) => sum + parseFloat(item.quantity), 0);
      const totalCost = adj.items.reduce((sum, item) => sum + parseFloat(item.total_cost), 0);
      
      return {
        ...adj,
        total_quantity: totalQuantity,
        total_cost: totalCost,
        items_count: adj.items.length
      };
    });

    res.json({
      success: true,
      data: adjustmentsWithTotals,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit)
      }
    });

  } catch (error) {
    console.error('Error en getAdjustments:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener ajustes de inventario'
    });
  }
};

/**
 * Obtener un ajuste por ID
 */
const getAdjustmentById = async (req, res) => {
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

    const adjustment = await InventoryAdjustment.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: InventoryAdjustmentItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku', 'current_stock']
            }
          ]
        }
      ]
    });

    if (!adjustment) {
      return res.status(404).json({
        success: false,
        message: 'Ajuste no encontrado'
      });
    }

    // Calcular totales
    const adj = adjustment.toJSON();
    const totalQuantity = adj.items.reduce((sum, item) => sum + parseFloat(item.quantity), 0);
    const totalCost = adj.items.reduce((sum, item) => sum + parseFloat(item.total_cost), 0);

    res.json({
      success: true,
      data: {
        ...adj,
        total_quantity: totalQuantity,
        total_cost: totalCost
      }
    });

  } catch (error) {
    console.error('Error en getAdjustmentById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener el ajuste'
    });
  }
};

/**
 * Crear nuevo ajuste de inventario
 */
const createAdjustment = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await t.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { adjustment_type, reason, warehouse_id, adjustment_date, notes, items } = req.body;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    // Validaciones
    if (!adjustment_type || !reason) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Tipo de ajuste y razón son requeridos'
      });
    }

    if (!items || items.length === 0) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Debe agregar al menos un producto'
      });
    }

    // Generar número de ajuste
    const year = new Date().getFullYear();
    const lastAdjustment = await InventoryAdjustment.findOne({
      where: {
        tenant_id,
        adjustment_number: {
          [Op.like]: `AJ-${year}-%`
        }
      },
      order: [['adjustment_number', 'DESC']],
      transaction: t
    });

    let adjustment_number;
    if (lastAdjustment) {
      const lastNumber = parseInt(lastAdjustment.adjustment_number.split('-')[2]);
      adjustment_number = `AJ-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
    } else {
      adjustment_number = `AJ-${year}-00001`;
    }

    // Crear ajuste
    const adjustment = await InventoryAdjustment.create({
      tenant_id,
      adjustment_number,
      adjustment_type,
      reason,
      warehouse_id,
      user_id,
      adjustment_date: adjustment_date || new Date(),
      status: 'draft',
      notes
    }, { transaction: t });

    // Crear items del ajuste
    const adjustmentItems = [];
    for (const item of items) {
      const product = await Product.findByPk(item.product_id, { transaction: t });
      
      if (!product) {
        await t.rollback();
        return res.status(404).json({
          success: false,
          message: `Producto con ID ${item.product_id} no encontrado`
        });
      }

      const quantity = parseFloat(item.quantity);
      const unit_cost = parseFloat(item.unit_cost || product.average_cost || 0);
      const total_cost = quantity * unit_cost;

      const adjustmentItem = await InventoryAdjustmentItem.create({
        adjustment_id: adjustment.id,
        product_id: item.product_id,
        quantity,
        unit_cost,
        total_cost,
        reason: item.reason || null,
        notes: item.notes || null
      }, { transaction: t });

      adjustmentItems.push(adjustmentItem);
    }

    await t.commit();

    // Obtener ajuste completo
    const newAdjustment = await InventoryAdjustment.findOne({
      where: { id: adjustment.id },
      include: [
        {
          model: InventoryAdjustmentItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku']
            }
          ]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: 'Ajuste creado exitosamente',
      data: newAdjustment
    });

  } catch (error) {
    if (t && !t.finished) {
      await t.rollback();
    }
    console.error('Error en createAdjustment:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear el ajuste'
    });
  }
};

/**
 * Actualizar ajuste de inventario (solo en estado draft)
 */
const updateAdjustment = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await t.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const { adjustment_type, reason, warehouse_id, adjustment_date, notes, items } = req.body;
    const tenant_id = req.user.tenant_id;

    // Buscar ajuste
    const adjustment = await InventoryAdjustment.findOne({
      where: { id, tenant_id },
      transaction: t
    });

    if (!adjustment) {
      await t.rollback();
      return res.status(404).json({
        success: false,
        message: 'Ajuste no encontrado'
      });
    }

    // Solo permitir editar ajustes en borrador
    if (adjustment.status !== 'draft') {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden editar ajustes en estado borrador'
      });
    }

    // Actualizar ajuste
    await adjustment.update({
      adjustment_type: adjustment_type || adjustment.adjustment_type,
      reason: reason || adjustment.reason,
      warehouse_id: warehouse_id || adjustment.warehouse_id,
      adjustment_date: adjustment_date || adjustment.adjustment_date,
      notes
    }, { transaction: t });

    // Si se enviaron items, actualizar
    if (items && items.length > 0) {
      // Eliminar items antiguos
      await InventoryAdjustmentItem.destroy({
        where: { adjustment_id: adjustment.id },
        transaction: t
      });

      // Crear nuevos items
      for (const item of items) {
        const product = await Product.findByPk(item.product_id, { transaction: t });
        
        if (!product) {
          await t.rollback();
          return res.status(404).json({
            success: false,
            message: `Producto con ID ${item.product_id} no encontrado`
          });
        }

        const quantity = parseFloat(item.quantity);
        const unit_cost = parseFloat(item.unit_cost || product.average_cost || 0);
        const total_cost = quantity * unit_cost;

        await InventoryAdjustmentItem.create({
          adjustment_id: adjustment.id,
          product_id: item.product_id,
          quantity,
          unit_cost,
          total_cost,
          reason: item.reason || null,
          notes: item.notes || null
        }, { transaction: t });
      }
    }

    await t.commit();

    // Obtener ajuste actualizado
    const updatedAdjustment = await InventoryAdjustment.findOne({
      where: { id },
      include: [
        {
          model: InventoryAdjustmentItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku']
            }
          ]
        }
      ]
    });

    res.json({
      success: true,
      message: 'Ajuste actualizado exitosamente',
      data: updatedAdjustment
    });

  } catch (error) {
    if (t && !t.finished) {
      await t.rollback();
    }
    console.error('Error en updateAdjustment:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el ajuste'
    });
  }
};

/**
 * Confirmar ajuste de inventario (genera movimientos y actualiza stock)
 */
const confirmAdjustment = async (req, res) => {
  const t = await sequelize.transaction();

  try {
    // ✅ Validar autenticación
    if (!req.user) {
      await t.rollback();
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    // ✅ Validar tenant_id
    if (!req.user.tenant_id) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'Usuario sin tenant asignado. Por favor contacte a soporte.'
      });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const user_id = req.user.id;

    // Buscar ajuste
    const adjustment = await InventoryAdjustment.findOne({
      where: { id, tenant_id },
      include: [
        {
          model: InventoryAdjustmentItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product'
            }
          ]
        }
      ],
      transaction: t
    });

    if (!adjustment) {
      await t.rollback();
      return res.status(404).json({
        success: false,
        message: 'Ajuste no encontrado'
      });
    }

    // Validar estado
    if (adjustment.status !== 'draft') {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'El ajuste ya fue confirmado o cancelado'
      });
    }

    // Validar que tenga items
    if (!adjustment.items || adjustment.items.length === 0) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: 'El ajuste no tiene productos'
      });
    }

    // Crear movimientos de inventario para cada item
    const movement_reason = adjustment.adjustment_type === 'entrada' 
      ? 'adjustment_in' 
      : 'adjustment_out';

    for (const item of adjustment.items) {
      // Validar stock disponible para ajustes de salida
      if (adjustment.adjustment_type === 'salida') {
        const currentStock = parseFloat(item.product.current_stock);
        const adjustQuantity = parseFloat(item.quantity);
        
        if (currentStock < adjustQuantity) {
          await t.rollback();
          return res.status(400).json({
            success: false,
            message: `Stock insuficiente para ${item.product.name}. Stock actual: ${currentStock}, requerido: ${adjustQuantity}`
          });
        }
      }

      // Crear movimiento
      await createMovement({
        tenant_id,
        movement_type: adjustment.adjustment_type,
        movement_reason,
        reference_type: 'adjustment',
        reference_id: adjustment.id,
        product_id: item.product_id,
        warehouse_id: adjustment.warehouse_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
        user_id,
        movement_date: adjustment.adjustment_date,
        notes: `Ajuste ${adjustment.adjustment_number}: ${adjustment.reason}`
      }, t);
    }

    // Actualizar estado del ajuste
    await adjustment.update({
      status: 'confirmed'
    }, { transaction: t });

    await t.commit();

    // Obtener ajuste confirmado
    const confirmedAdjustment = await InventoryAdjustment.findOne({
      where: { id },
      include: [
        {
          model: InventoryAdjustmentItem,
          as: 'items',
          include: [
            {
              model: Product,
              as: 'product',
              attributes: ['id', 'name', 'sku', 'current_stock']
            }
          ]
        }
      ]
    });

    // 🔔 Verificación automática de alertas
    const product_ids = adjustment.items.map(item => item.product_id);
    markProductsForAlertCheck(res, product_ids, tenant_id);

    res.json({
      success: true,
      message: 'Ajuste confirmado exitosamente',
      data: confirmedAdjustment
    });

  } catch (error) {
    // Solo hacer rollback si la transacción no se ha finalizado
    if (t && !t.finished) {
      await t.rollback();
    }
    console.error('Error en confirmAdjustment:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error al confirmar el ajuste'
    });
  }
};

/**
 * Cancelar ajuste de inventario
 */
const cancelAdjustment = async (req, res) => {
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

    const adjustment = await InventoryAdjustment.findOne({
      where: { id, tenant_id }
    });

    if (!adjustment) {
      return res.status(404).json({
        success: false,
        message: 'Ajuste no encontrado'
      });
    }

    // No permitir cancelar ajustes ya confirmados
    if (adjustment.status === 'confirmed') {
      return res.status(400).json({
        success: false,
        message: 'No se puede cancelar un ajuste ya confirmado'
      });
    }

    await adjustment.update({
      status: 'cancelled'
    });

    res.json({
      success: true,
      message: 'Ajuste cancelado exitosamente',
      data: adjustment
    });

  } catch (error) {
    console.error('Error en cancelAdjustment:', error);
    res.status(500).json({
      success: false,
      message: 'Error al cancelar el ajuste'
    });
  }
};

/**
 * Eliminar ajuste (solo en estado draft)
 */
const deleteAdjustment = async (req, res) => {
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

    const adjustment = await InventoryAdjustment.findOne({
      where: { id, tenant_id }
    });

    if (!adjustment) {
      return res.status(404).json({
        success: false,
        message: 'Ajuste no encontrado'
      });
    }

    // Solo permitir eliminar borradores
    if (adjustment.status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'Solo se pueden eliminar ajustes en estado borrador'
      });
    }

    await adjustment.destroy();

    res.json({
      success: true,
      message: 'Ajuste eliminado exitosamente'
    });

  } catch (error) {
    console.error('Error en deleteAdjustment:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar el ajuste'
    });
  }
};

/**
 * Obtener estadísticas de ajustes
 */
const getAdjustmentsStats = async (req, res) => {
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

    const tenant_id = req.user.tenant_id;

    // Total de ajustes
    const totalAdjustments = await InventoryAdjustment.count({
      where: { tenant_id }
    });

    // Ajustes pendientes (draft)
    const pendingAdjustments = await InventoryAdjustment.count({
      where: { tenant_id, status: 'draft' }
    });

    // Ajustes confirmados este mes
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    
    const confirmedThisMonth = await InventoryAdjustment.count({
      where: {
        tenant_id,
        status: 'confirmed',
        adjustment_date: {
          [Op.gte]: firstDayOfMonth
        }
      }
    });

    res.json({
      success: true,
      data: {
        total: totalAdjustments,
        pending: pendingAdjustments,
        confirmed_this_month: confirmedThisMonth
      }
    });

  } catch (error) {
    console.error('Error en getAdjustmentsStats:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas'
    });
  }
};

module.exports = {
  getAdjustments,
  getAdjustmentById,
  createAdjustment,
  updateAdjustment,
  confirmAdjustment,
  cancelAdjustment,
  deleteAdjustment,
  getAdjustmentsStats
};