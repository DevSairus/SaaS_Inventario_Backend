const { InventoryMovement, Product, Warehouse } = require('../../models/inventory');
const { Op } = require('sequelize');
const { checkAlertsForProduct } = require('../../middleware/autoCheckAlerts.middleware');
const { nextMovementNumber, nextMovementNumbers } = require('../../services/inventory/movementNumber.service');
const { bulkUpdateById } = require('../../utils/bulkUpdate');
const { roundNumeric } = require('../../utils/numberUtils');
const { mapWithConcurrencyLimit } = require('../../utils/concurrency');
const { getCurrentSchema, runWithTenantSchema } = require('../../config/tenantContext');

// Revisión de alertas de stock pendiente por transacción: se junta todo lo
// que tocó el documento y se revisa una vez, después del commit, de a pocos
// (un conteo físico o un ajuste de miles de líneas disparaba miles de
// revisiones en paralelo y dejaba al resto del sitio sin conexiones).
const ALERT_CHECK_CONCURRENCY = 2;
const pendingAlertChecks = new WeakMap(); // transaction -> Set(product_id)

function runAlertChecks(productIds, tenant_id, schema) {
  const run = () => mapWithConcurrencyLimit([...productIds], ALERT_CHECK_CONCURRENCY,
    (id) => checkAlertsForProduct(id, tenant_id).catch(() => {}));
  return schema ? runWithTenantSchema(schema, run) : run();
}

function scheduleAlertCheck(product_id, tenant_id, transaction) {
  const schema = getCurrentSchema();
  if (!transaction) {
    setImmediate(() => { runAlertChecks([product_id], tenant_id, schema).catch(() => {}); });
    return;
  }
  let ids = pendingAlertChecks.get(transaction);
  if (!ids) {
    ids = new Set();
    pendingAlertChecks.set(transaction, ids);
    transaction.afterCommit(() => {
      setImmediate(() => { runAlertChecks(ids, tenant_id, schema).catch(() => {}); });
    });
  }
  ids.add(product_id);
}
const { resolveBranchFilter } = require('../../utils/branchFilter');

/**
 * Obtener todos los movimientos con filtros y paginación
 */
const getMovements = async (req, res) => {
  try {
    const {
      search = '',
      product_id,
      direction,
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

    // "movement_type" NO es 'entrada'/'salida' — guarda la clasificación de
    // negocio (sale, purchase, customer_return, etc.). El filtro de
    // entrada/salida real va contra "direction" ('in' | 'out').
    if (direction) {
      where.direction = direction;
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

    // InventoryMovement no tiene columna branch_id propia (el inventario es
    // global/compartido entre sedes), pero como 1 sede = 1 bodega (decisión
    // de diseño de Fase 1), filtrar por sede equivale a filtrar por la
    // bodega asociada a esa sede.
    // Para roles no-admin, se ignora el branch_id de query y se fuerza la
    // sede autorizada del usuario.
    const branch_id = resolveBranchFilter(req);
    if (branch_id) {
      const warehouse = await Warehouse.findOne({
        where: { tenant_id, branch_id },
        attributes: ['id']
      });
      // Si la sede no tiene bodega asociada, forzamos un resultado vacío
      // en lugar de ignorar el filtro silenciosamente.
      where.warehouse_id = warehouse ? warehouse.id : null;
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

    const { page = 1, limit = 25 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Totales sobre TODO el rango (sin paginar)
    const allMovements = await InventoryMovement.findAll({
      where,
      attributes: ['movement_type', 'direction', 'quantity', 'total_cost', 'new_stock'],
      order: [['movement_date', 'ASC'], ['created_at', 'ASC']],
      raw: true
    });

    // OJO: "movement_type" NO es 'entrada'/'salida' — guarda la clasificación de
    // negocio (sale, purchase, customer_return, etc.) porque el CHECK constraint
    // de la tabla no permite esos literales. El campo confiable para in/out es
    // "direction" ('in' | 'out'), que sí se setea siempre en createMovement().
    const entradas = allMovements.filter(m => m.direction === 'in');
    const salidas  = allMovements.filter(m => m.direction === 'out');
    const totalEntradas      = entradas.reduce((s, m) => s + parseFloat(m.quantity), 0);
    const totalSalidas       = salidas.reduce((s, m) => s + parseFloat(m.quantity), 0);
    const totalCostoEntradas = entradas.reduce((s, m) => s + parseFloat(m.total_cost), 0);
    const stockActual        = allMovements.length > 0 ? allMovements[allMovements.length - 1].new_stock : 0;

    // Solo la página solicitada
    const { count, rows: movements } = await InventoryMovement.findAndCountAll({
      where,
      include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'sku'] }],
      order: [['movement_date', 'ASC'], ['created_at', 'ASC']],
      limit: limitNum,
      offset
    });

    res.json({
      success: true,
      data: {
        movements,
        pagination: {
          total: allMovements.length,
          page: pageNum,
          limit: limitNum,
          pages: Math.ceil(allMovements.length / limitNum)
        },
        summary: {
          total_movements: allMovements.length,
          total_entradas: totalEntradas,
          total_salidas: totalSalidas,
          stock_actual: stockActual,
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

// Cálculo de un movimiento sobre el estado actual del producto, sin tocar la
// BD: lo comparten createMovement (una línea) y createMovementsBatch (un
// documento entero), así ambos dan exactamente el mismo resultado.
function computeMovement(product, movementData) {
  const { tenant_id, movement_type, movement_reason, reference_type, reference_id, product_id,
    warehouse_id, quantity, unit_cost, user_id, movement_date, notes } = movementData;

  // Usar warehouse_id del producto como fallback si no se proporciona
  const effectiveWarehouseId = warehouse_id || product.warehouse_id;

  const previous_stock = parseFloat(product.current_stock);
  let new_stock;

  // Calcular nuevo stock
  if (movement_type === 'entrada') {
    new_stock = previous_stock + parseFloat(quantity);
  } else if (movement_type === 'salida') {
    new_stock = previous_stock - parseFloat(quantity);

    // Validar que no quede stock negativo
    if (new_stock < 0 && !product.allow_negative_stock) {
      throw new Error(`Stock insuficiente para el producto ${product.name}. Stock actual: ${previous_stock}, solicitado: ${quantity}`);
    }
  } else {
    throw new Error('Tipo de movimiento inválido');
  }

  // Calcular costo total
  const total_cost = parseFloat(quantity) * parseFloat(unit_cost);

  const movement = {
    tenant_id,
    movement_type: movement_reason,
    direction: movement_type === 'entrada' ? 'in' : 'out',
    movement_reason: movement_reason || notes || 'movimiento',
    reference_type,
    reference_id,
    product_id,
    warehouse_id: effectiveWarehouseId,
    quantity: parseFloat(quantity),
    unit_cost: parseFloat(unit_cost),
    total_cost,
    previous_stock,
    new_stock,
    user_id,
    movement_date: movement_date || new Date(),
    notes
  };

  // Actualizar stock del producto -- available_stock también se sincroniza
  // aquí (H3): antes solo lo hacían compras/transferencias/consumos
  // internos/devoluciones/voidSale a mano, y ventas/OT/ajustes (que pasan
  // por este mismo createMovement) lo dejaban desincronizado.
  const productChanges = {
    current_stock: new_stock,
    available_stock: new_stock - parseFloat(product.reserved_stock || 0)
  };

  // Si es entrada, actualizar costo promedio (en el mismo UPDATE)
  if (movement_type === 'entrada') {
    const totalValue = (previous_stock * parseFloat(product.average_cost || 0)) + total_cost;
    const totalQuantity = previous_stock + parseFloat(quantity);
    productChanges.average_cost = totalQuantity > 0 ? totalValue / totalQuantity : unit_cost;
  }

  return { movement, productChanges };
}

/**
 * Crear movimiento de inventario (función auxiliar, no ruta pública)
 * Esta función es llamada por otros procesos (recepción de compras, ajustes, ventas, etc.)
 */
const createMovement = async (movementData, transaction) => {
  const { tenant_id, movement_type, product_id } = movementData;

  // Obtener el producto (con lock para evitar lecturas/escrituras concurrentes de current_stock)
  const product = await Product.findByPk(product_id, {
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    transaction
  });

  if (!product) {
    throw new Error('Producto no encontrado');
  }

  const { movement: movementRow, productChanges } = computeMovement(product, movementData);

  // Número de movimiento: secuencia de Postgres, sin lock (antes el FOR
  // UPDATE sobre el último MOV- del año serializaba todos los documentos del
  // tenant hasta su commit -- ver movementNumber.service.js).
  const movement_number = await nextMovementNumber({ transaction });

  const movement = await InventoryMovement.create({ ...movementRow, movement_number }, { transaction });

  await product.update(productChanges, { transaction });

  // Auto-verificar alertas de stock en salidas, DESPUÉS del commit: antes
  // corría con la transacción todavía abierta (leía el stock viejo y pedía
  // conexiones extra del pool por cada línea del documento). Un documento con
  // varias líneas del mismo producto lo revisa una sola vez.
  if (movement_type === 'salida') {
    scheduleAlertCheck(product_id, tenant_id, transaction);
  }

  return movement;
};

// Escala de las columnas numéricas de products que toca un movimiento: al
// procesar en lote, el estado en memoria se redondea igual que lo haría la BD
// al guardar, para que la línea siguiente de un mismo producto vea lo mismo
// que vería si lo releyera (como hace createMovement línea por línea).
const PRODUCT_STOCK_SCALE = { current_stock: 4, available_stock: 4, average_cost: 2 };

/**
 * Igual que llamar createMovement por cada línea, en orden, pero con las
 * lecturas y escrituras en bloque: una lectura con lock de todos los
 * productos, un INSERT de todos los movimientos y un UPDATE de todos los
 * productos -- unas pocas consultas en vez de ~5 por línea.
 *
 * Devuelve { movements, products } -- products: Map id -> instancia con el
 * estado final en memoria (para que el llamador siga calculando sobre él).
 * Con skipMissing, las líneas de productos que ya no existen se omiten en vez
 * de fallar (lo que hacía la recepción de compras línea por línea).
 */
async function createMovementsBatch(lines, transaction, { skipMissing = false } = {}) {
  if (!lines.length) return { movements: [], products: new Map() };
  const ids = [...new Set(lines.map((l) => l.product_id))];
  // Orden fijo por id: dos documentos que bloquean los mismos productos los
  // toman en el mismo orden y no se bloquean mutuamente (deadlock).
  const found = await Product.findAll({
    where: { id: ids },
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
    order: [['id', 'ASC']],
    transaction,
  });
  const products = new Map(found.map((p) => [p.id, p]));

  const rows = [];
  const changed = new Set();
  const outbound = new Set();
  for (const line of lines) {
    const product = products.get(line.product_id);
    if (!product) {
      if (skipMissing) continue;
      throw new Error('Producto no encontrado');
    }
    const { movement, productChanges } = computeMovement(product, line);
    rows.push(movement);
    for (const [col, value] of Object.entries(productChanges)) {
      product.setDataValue(col, roundNumeric(value, PRODUCT_STOCK_SCALE[col]));
    }
    changed.add(product.id);
    if (line.movement_type === 'salida') outbound.add(product.id);
  }

  if (!rows.length) return { movements: [], products };
  const numbers = await nextMovementNumbers(rows.length, { transaction });
  rows.forEach((row, i) => { row.movement_number = numbers[i]; });
  const movements = await InventoryMovement.bulkCreate(rows, { transaction });

  const columns = ['current_stock', 'available_stock', 'average_cost'];
  await bulkUpdateById(Product, [...changed].map((id) => {
    const p = products.get(id);
    return Object.fromEntries([['id', id], ...columns.map((c) => [c, p.getDataValue(c)])]);
  }), columns, { transaction });

  const tenant_id = lines[0].tenant_id;
  for (const id of outbound) scheduleAlertCheck(id, tenant_id, transaction);

  return { movements, products };
}

module.exports = {
  getMovements,
  getProductKardex,
  getMovementsStats,
  createMovement,
  createMovementsBatch
};