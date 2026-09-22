const logger = require('../../config/logger');
const audit = require('../../utils/audit');
const { InventoryAdjustment, InventoryAdjustmentItem, Product } = require('../../models/inventory');
const { createMovement } = require('./movements.controller');
const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { markProductsForAlertCheck } = require('../../middleware/autoCheckAlerts.middleware');
const { resolveUnitCost } = require('../../utils/costResolver');

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
    logger.error('Error en getAdjustments:', error);
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
    logger.error('Error en getAdjustmentById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener el ajuste'
    });
  }
};

// ── Helper de error HTTP (mismo patrón que voidSale.js#httpError) ───────────
function httpError(statusCode, payload) {
  const err = new Error(payload.message);
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

/**
 * Núcleo reutilizable de "crear ajuste". Extraído del handler HTTP (mismo
 * patrón que voidSaleCore en voidSale.js) para que physicalCounts.controller.js
 * pueda crear el ajuste de entrada/salida de una sesión de conteo dentro de su
 * PROPIA transacción (junto con confirmAdjustmentCore y el resto de la
 * aplicación), sin pasar por req/res.
 *
 * Si se recibe `transaction`, la función NO abre ni cierra su propia
 * transacción (el llamador es dueño del ciclo de vida); si no se recibe,
 * abre y confirma/revierte una propia (comportamiento igual al handler HTTP
 * original de createAdjustment).
 *
 * Devuelve { adjustment_id, adjustment_number } o lanza un Error con
 * .statusCode/.payload.
 */
async function createAdjustmentCore({ tenant_id, user_id, adjustment_type, reason, warehouse_id, adjustment_date, notes, items, physical_count_id = null }, transaction = null) {
  const t = transaction || await sequelize.transaction();
  const ownsTransaction = !transaction;

  try {
    if (!adjustment_type || !reason) {
      throw httpError(400, { success: false, message: 'Tipo de ajuste y razón son requeridos' });
    }

    if (!items || items.length === 0) {
      throw httpError(400, { success: false, message: 'Debe agregar al menos un producto' });
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
      notes,
      physical_count_id
    }, { transaction: t });

    // Crear items del ajuste
    for (const item of items) {
      const product = await Product.findOne({
        where: { id: item.product_id, tenant_id },
        transaction: t
      });

      if (!product) {
        throw httpError(404, { success: false, message: `Producto con ID ${item.product_id} no encontrado` });
      }

      const quantity = parseFloat(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw httpError(400, { success: false, message: `Cantidad inválida para el producto ${product.name}. Debe ser un número mayor a cero` });
      }

      const unit_cost = resolveUnitCost(item, product);
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

    if (ownsTransaction) await t.commit();

    return { adjustment_id: adjustment.id, adjustment_number };

  } catch (error) {
    if (ownsTransaction && t && !t.finished) {
      await t.rollback();
    }
    if (error.statusCode) throw error;
    logger.error('Error en createAdjustmentCore:', error);
    throw httpError(500, { success: false, message: 'Error al crear el ajuste' });
  }
}

/**
 * Crear nuevo ajuste de inventario (wrapper HTTP delgado sobre
 * createAdjustmentCore -- comportamiento idéntico al de antes del refactor).
 */
const createAdjustment = async (req, res) => {
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

  const { adjustment_type, reason, warehouse_id, adjustment_date, notes, items } = req.body;
  const tenant_id = req.user.tenant_id;
  const user_id = req.user.id;

  try {
    const { adjustment_id } = await createAdjustmentCore({
      tenant_id, user_id, adjustment_type, reason, warehouse_id, adjustment_date, notes, items
    });

    // Obtener ajuste completo
    const newAdjustment = await InventoryAdjustment.findOne({
      where: { id: adjustment_id },
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
    if (error.statusCode && error.payload) {
      return res.status(error.statusCode).json(error.payload);
    }
    logger.error('Error en createAdjustment:', error);
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
        const product = await Product.findOne({
          where: { id: item.product_id, tenant_id },
          transaction: t
        });

        if (!product) {
          await t.rollback();
          return res.status(404).json({
            success: false,
            message: `Producto con ID ${item.product_id} no encontrado`
          });
        }

        const quantity = parseFloat(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          await t.rollback();
          return res.status(400).json({
            success: false,
            message: `Cantidad inválida para el producto ${product.name}. Debe ser un número mayor a cero`
          });
        }

        const unit_cost = resolveUnitCost(item, product);
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
    logger.error('Error en updateAdjustment:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el ajuste'
    });
  }
};

/**
 * Núcleo reutilizable de "confirmar ajuste" (genera movimientos y actualiza
 * stock). Mismo patrón de extracción que createAdjustmentCore/voidSaleCore:
 * si se recibe `transaction` no la abre ni cierra (para que
 * physicalCounts.controller.js pueda encadenar create+confirm de dos ajustes
 * dentro de una sola transacción de aplicación).
 *
 * Devuelve { adjustment, product_ids } (adjustment con items+product
 * cargados, ya en estado 'confirmed') o lanza un Error con
 * .statusCode/.payload.
 */
async function confirmAdjustmentCore({ tenant_id, user_id, adjustment_id }, transaction = null) {
  const t = transaction || await sequelize.transaction();
  const ownsTransaction = !transaction;

  try {
    // Buscar ajuste
    const adjustment = await InventoryAdjustment.findOne({
      where: { id: adjustment_id, tenant_id },
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
      throw httpError(404, { success: false, message: 'Ajuste no encontrado' });
    }

    // Validar estado
    if (adjustment.status !== 'draft') {
      throw httpError(400, { success: false, message: 'El ajuste ya fue confirmado o cancelado' });
    }

    // Validar que tenga items
    if (!adjustment.items || adjustment.items.length === 0) {
      throw httpError(400, { success: false, message: 'El ajuste no tiene productos' });
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
          throw httpError(400, { success: false, message: `Stock insuficiente para ${item.product.name}. Stock actual: ${currentStock}, requerido: ${adjustQuantity}` });
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

    if (ownsTransaction) await t.commit();

    const product_ids = adjustment.items.map(item => item.product_id);
    return { adjustment, product_ids };

  } catch (error) {
    if (ownsTransaction && t && !t.finished) {
      await t.rollback();
    }
    if (error.statusCode) throw error;
    logger.error('Error en confirmAdjustmentCore:', error);
    throw httpError(500, { success: false, message: error.message || 'Error al confirmar el ajuste' });
  }
}

/**
 * Confirmar ajuste de inventario (wrapper HTTP delgado sobre
 * confirmAdjustmentCore -- comportamiento idéntico al de antes del refactor).
 */
const confirmAdjustment = async (req, res) => {
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
  const user_id = req.user.id;

  try {
    const { product_ids } = await confirmAdjustmentCore({ tenant_id, user_id, adjustment_id: id });

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
    markProductsForAlertCheck(res, product_ids, tenant_id);

    // Asiento contable en borrador (no bloqueante: si falla, solo se loguea).
    setImmediate(async () => {
      try {
        const { generateAdjustmentEntry } = require('../../services/accounting/autoEntries.service');
        await generateAdjustmentEntry(confirmedAdjustment, confirmedAdjustment.items, tenant_id, user_id);
      } catch (err) {
        logger.warn(`[accounting] Error generando asiento del ajuste ${id}: ${err.message}`);
      }
    });

    // Audit
    setImmediate(() => audit({ tenant_id, user_id: req.user?.id, action: 'INVENTORY_ADJUSTMENT',
      entity: 'adjustment', entity_id: product_ids.join(','),
      changes: { products_affected: product_ids.length },
      req }));

    res.json({
      success: true,
      message: 'Ajuste confirmado exitosamente',
      data: confirmedAdjustment
    });

  } catch (error) {
    if (error.statusCode && error.payload) {
      return res.status(error.statusCode).json(error.payload);
    }
    logger.error('Error en confirmAdjustment:', error);
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
    logger.error('Error en cancelAdjustment:', error);
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
    logger.error('Error en deleteAdjustment:', error);
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
    logger.error('Error en getAdjustmentsStats:', error);
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
  getAdjustmentsStats,
  // Núcleos reutilizables (ver physicalCounts.controller.js)
  createAdjustmentCore,
  confirmAdjustmentCore
};