const { InventoryMovement, Product } = require('../../models/inventory');
const { Op } = require('sequelize');

/**
 * Obtener todos los movimientos con filtros y paginación
 */
const getMovements = async (req, res) => {
  try {
    const {
      search = '',
      product_id,
      movement_type,
      movement_reason,
      reference_type,
      reference_id,
      start_date,
      end_date,
      sort_by = 'movement_date',
      sort_order = 'DESC',
      page = 1,
      limit = 50
    } = req.query;

    const tenant_id = req.user.tenant_id;
    const offset = (page - 1) * limit;

    // Construir condiciones de búsqueda
    const where = { tenant_id };

    if (product_id) {
      where.product_id = product_id;
    }

    if (movement_type) {
      where.movement_type = movement_type;
    }

    if (movement_reason) {
      where.movement_reason = movement_reason;
    }

    if (reference_type) {
      where.reference_type = reference_type;
    }

    if (reference_id) {
      where.reference_id = reference_id;
    }

    if (start_date) {
      where.movement_date = {
        ...where.movement_date,
        [Op.gte]: start_date
      };
    }

    if (end_date) {
      where.movement_date = {
        ...where.movement_date,
        [Op.lte]: end_date
      };
    }

    if (search) {
      where[Op.or] = [
        { movement_number: { [Op.iLike]: `%${search}%` } },
        { notes: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // Obtener movimientos
    const { count, rows } = await InventoryMovement.findAndCountAll({
      where,
      include: [
        {
          model: Product,
          as: 'product',
          attributes: ['id', 'name', 'sku', 'current_stock']
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
    console.error('Error en getMovements:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener movimientos de inventario'
    });
  }
};

/**
 * Obtener kardex de un producto (historial completo de movimientos)
 */
const getProductKardex = async (req, res) => {
  try {
    const { product_id } = req.params;
    const { start_date, end_date } = req.query;
    const tenant_id = req.user.tenant_id;

    const where = {
      tenant_id,
      product_id
    };

    if (start_date) {
      where.movement_date = {
        ...where.movement_date,
        [Op.gte]: start_date
      };
    }

    if (end_date) {
      where.movement_date = {
        ...where.movement_date,
        [Op.lte]: end_date
      };
    }

    const movements = await InventoryMovement.findAll({
      where,
      include: [
        {
          model: Product,
          as: 'product',
          attributes: ['id', 'name', 'sku']
        }
      ],
      order: [['movement_date', 'ASC'], ['created_at', 'ASC']]
    });

    // Calcular resumen
    const entradas = movements.filter(m => m.movement_type === 'entrada');
    const salidas = movements.filter(m => m.movement_type === 'salida');
    
    const totalEntradas = entradas.reduce((sum, m) => sum + parseFloat(m.quantity), 0);
    const totalSalidas = salidas.reduce((sum, m) => sum + parseFloat(m.quantity), 0);
    const totalCostoEntradas = entradas.reduce((sum, m) => sum + parseFloat(m.total_cost), 0);

    res.json({
      success: true,
      data: {
        movements,
        summary: {
          total_movements: movements.length,
          total_entradas: totalEntradas,
          total_salidas: totalSalidas,
          stock_actual: movements.length > 0 ? movements[movements.length - 1].new_stock : 0,
          total_costo_entradas: totalCostoEntradas,
          costo_promedio: totalEntradas > 0 ? totalCostoEntradas / totalEntradas : 0
        }
      }
    });

  } catch (error) {
    console.error('Error en getProductKardex:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener kardex del producto'
    });
  }
};

/**
 * Obtener estadísticas de movimientos
 */
const getMovementsStats = async (req, res) => {
  try {
    const tenant_id = req.user.tenant_id;
    const { sequelize } = require('../../config/database');

    // Total de movimientos hoy
    const today = new Date().toISOString().split('T')[0];
    const movementsToday = await InventoryMovement.count({
      where: {
        tenant_id,
        movement_date: today
      }
    });

    // Movimientos del mes
    const firstDayOfMonth = new Date();
    firstDayOfMonth.setDate(1);
    const movementsThisMonth = await InventoryMovement.count({
      where: {
        tenant_id,
        movement_date: {
          [Op.gte]: firstDayOfMonth
        }
      }
    });

    // Entradas y salidas del mes
    const entradasMes = await InventoryMovement.sum('quantity', {
      where: {
        tenant_id,
        movement_type: 'entrada',
        movement_date: {
          [Op.gte]: firstDayOfMonth
        }
      }
    });

    const salidasMes = await InventoryMovement.sum('quantity', {
      where: {
        tenant_id,
        movement_type: 'salida',
        movement_date: {
          [Op.gte]: firstDayOfMonth
        }
      }
    });

    res.json({
      success: true,
      data: {
        movements_today: movementsToday || 0,
        movements_this_month: movementsThisMonth || 0,
        entradas_mes: parseFloat(entradasMes) || 0,
        salidas_mes: parseFloat(salidasMes) || 0
      }
    });

  } catch (error) {
    console.error('Error en getMovementsStats:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas'
    });
  }
};

/**
 * Crear movimiento de inventario (función auxiliar, no ruta pública)
 * Esta función es llamada por otros procesos (recepción de compras, ajustes, ventas, etc.)
 */
const createMovement = async (movementData, transaction) => {
  const { sequelize } = require('../../config/database');
  
  const {
    tenant_id,
    movement_type,
    movement_reason,
    reference_type,
    reference_id,
    product_id,
    warehouse_id,
    quantity,
    unit_cost,
    user_id,
    movement_date,
    notes
  } = movementData;

  // Obtener el producto
  const product = await Product.findByPk(product_id, { transaction });
  
  if (!product) {
    throw new Error('Producto no encontrado');
  }

  const previous_stock = parseFloat(product.current_stock);
  let new_stock;

  // Calcular nuevo stock
  if (movement_type === 'entrada') {
    new_stock = previous_stock + parseFloat(quantity);
  } else if (movement_type === 'salida') {
    new_stock = previous_stock - parseFloat(quantity);
    
    // Validar que no quede stock negativo
    if (new_stock < 0) {
      throw new Error(`Stock insuficiente para el producto ${product.name}. Stock actual: ${previous_stock}, solicitado: ${quantity}`);
    }
  } else {
    throw new Error('Tipo de movimiento inválido');
  }

  // Generar número de movimiento
  const year = new Date().getFullYear();
  const lastMovement = await InventoryMovement.findOne({
    where: {
      tenant_id,
      movement_number: {
        [Op.like]: `MOV-${year}-%`
      }
    },
    order: [['movement_number', 'DESC']],
    transaction
  });

  let movement_number;
  if (lastMovement) {
    const lastNumber = parseInt(lastMovement.movement_number.split('-')[2]);
    movement_number = `MOV-${year}-${String(lastNumber + 1).padStart(5, '0')}`;
  } else {
    movement_number = `MOV-${year}-00001`;
  }

  // Calcular costo total
  const total_cost = parseFloat(quantity) * parseFloat(unit_cost);

  // Crear movimiento
  const movement = await InventoryMovement.create({
    tenant_id,
    movement_number,
    movement_type,
    movement_reason,
    reference_type,
    reference_id,
    product_id,
    warehouse_id,
    quantity: parseFloat(quantity),
    unit_cost: parseFloat(unit_cost),
    total_cost,
    previous_stock,
    new_stock,
    user_id,
    movement_date: movement_date || new Date(),
    notes
  }, { transaction });

  // Actualizar stock del producto
  await product.update({
    current_stock: new_stock
  }, { transaction });

  // Si es entrada, actualizar costo promedio
  if (movement_type === 'entrada') {
    const totalValue = (previous_stock * parseFloat(product.average_cost || 0)) + total_cost;
    const totalQuantity = previous_stock + parseFloat(quantity);
    const newAverageCost = totalQuantity > 0 ? totalValue / totalQuantity : unit_cost;
    
    await product.update({
      average_cost: newAverageCost
    }, { transaction });
  }

  return movement;
};

module.exports = {
  getMovements,
  getProductKardex,
  getMovementsStats,
  createMovement
};