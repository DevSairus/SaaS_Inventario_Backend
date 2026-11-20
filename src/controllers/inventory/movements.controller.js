const { weightedAverageCost } = require('../../utils/costResolver');
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
 * Kardex de un producto: movimientos con saldo en cantidad y en valor
 * (costo de cada movimiento tal como quedó registrado), saldo inicial del
 * rango, y datos para decidir: último costo/compra, última venta, precio,
 * utilidad configurada vs. realizada en el periodo.
 *
 * Con `warehouse_id` el saldo se acumula solo con los movimientos de esa
 * bodega (arranca en 0); sin él, parte del stock previo del primer
 * movimiento (previous_stock es el stock global del producto).
 */
const getProductKardex = async (req, res) => {
  try {
    const { product_id } = req.params;
    const { start_date, end_date, warehouse_id } = req.query;
    const tenant_id = req.user.tenant_id;
    const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
    if ((start_date && !isDate(start_date)) || (end_date && !isDate(end_date))) {
      return res.status(400).json({ success: false, message: 'Fechas inválidas. Use YYYY-MM-DD' });
    }

    const product = await Product.findOne({ where: { id: product_id, tenant_id } });
    if (!product) return res.status(404).json({ success: false, message: 'Producto no encontrado' });

    // Todo el historial hasta end_date (el saldo inicial del rango sale de
    // lo anterior a start_date).
    const where = { tenant_id, product_id };
    if (warehouse_id) where.warehouse_id = warehouse_id;
    if (end_date) where.movement_date = { [Op.lte]: end_date };
    const all = await InventoryMovement.findAll({
      where,
      include: [{ model: Warehouse, as: 'warehouse', attributes: ['id', 'name'], required: false }],
      order: [['movement_date', 'ASC'], ['created_at', 'ASC']],
    });

    const r2 = (n) => Math.round(n * 100) / 100;
    let qty = 0;
    let value = 0;
    if (!warehouse_id && all.length) {
      qty = parseFloat(all[0].previous_stock) || 0;
      value = qty * (parseFloat(all[0].unit_cost) || parseFloat(product.average_cost) || 0);
    }
    let opening = start_date ? null : { qty: r2(qty), value: r2(value) };
    const inRange = [];
    const totals = { in_qty: 0, in_value: 0, out_qty: 0, out_value: 0 };
    for (const m of all) {
      const date = String(m.movement_date).slice(0, 10);
      if (start_date && opening === null && date >= start_date) opening = { qty: r2(qty), value: r2(value) };
      const q = parseFloat(m.quantity) || 0;
      const cost = parseFloat(m.total_cost) || q * (parseFloat(m.unit_cost) || 0);
      const sign = m.direction === 'in' ? 1 : (m.direction === 'out' ? -1 : 0);
      qty += sign * q;
      value += sign * cost;
      if (start_date && date < start_date) continue;
      if (sign > 0) { totals.in_qty += q; totals.in_value += cost; }
      if (sign < 0) { totals.out_qty += q; totals.out_value += cost; }
      inRange.push({
        ...m.toJSON(),
        balance_qty: r2(qty),
        balance_value: r2(value),
        balance_avg_cost: qty > 0 ? r2(value / qty) : null,
      });
    }
    if (opening === null) opening = { qty: r2(qty), value: r2(value) };

    // Ventas del producto en el rango (neto de devoluciones aprobadas):
    // unidades, ingreso, costo y utilidad realizada; y la última venta.
    const { sequelize } = require('../../config/database');
    const { QueryTypes } = require('sequelize');
    const { remisionSqlCondition } = require('../../utils/remisionVisibility');
    const schema = getCurrentSchema() || 'public';
    const rangeSql = [
      start_date ? 'AND COALESCE(s.sale_date, s.created_at)::date >= :startDate' : '',
      end_date ? 'AND COALESCE(s.sale_date, s.created_at)::date <= :endDate' : '',
    ].join(' ');
    const baseSql = `
      FROM "${schema}"."sale_items" si
      INNER JOIN "${schema}"."sales" s ON s.id = si.sale_id
      LEFT JOIN (
        SELECT cri.sale_item_id, SUM(cri.quantity)::numeric AS rq, SUM(cri.subtotal)::numeric AS rs
        FROM "${schema}"."customer_return_items" cri
        INNER JOIN "${schema}"."customer_returns" cr ON cr.id = cri.return_id
        WHERE cr.tenant_id = :tenantId AND cr.status = 'approved'
        GROUP BY cri.sale_item_id
      ) ret ON ret.sale_item_id = si.id
      WHERE s.tenant_id = :tenantId AND si.product_id = :productId
        AND s.status IN ('completed', 'pending')
        AND (s.document_type IS NULL OR s.document_type::text <> 'cotizacion')
        AND ${remisionSqlCondition(req, 's')}`;
    const replacements = { tenantId: tenant_id, productId: product_id, startDate: start_date || null, endDate: end_date || null };
    const [salesRow] = await sequelize.query(`
      SELECT COUNT(DISTINCT s.id)::int AS sales_count,
        COALESCE(SUM(si.quantity - COALESCE(ret.rq, 0)), 0)::numeric AS qty,
        COALESCE(SUM(si.subtotal - COALESCE(ret.rs, 0)), 0)::numeric AS revenue,
        COALESCE(SUM((si.quantity - COALESCE(ret.rq, 0)) * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE :avgCost END), 0)::numeric AS cost
      ${baseSql} ${rangeSql}`, {
      replacements: { ...replacements, avgCost: parseFloat(product.average_cost) || 0 }, type: QueryTypes.SELECT,
    });
    const [lastSale] = await sequelize.query(`
      SELECT s.id, s.sale_number, COALESCE(s.sale_date, s.created_at)::date AS sale_date, s.customer_name,
        si.quantity, si.unit_price
      ${baseSql}
      ORDER BY COALESCE(s.sale_date, s.created_at) DESC, s.created_at DESC LIMIT 1`, {
      replacements, type: QueryTypes.SELECT,
    });

    const { productSalePrice, impliedMargin } = require('../../utils/salePricing');
    const { getMarginMethod } = require('../../services/inventory/productMargin.service');
    const method = await getMarginMethod(tenant_id);
    const price = productSalePrice(product);
    const avgCost = parseFloat(product.average_cost) || 0;
    const stock = parseFloat(product.current_stock) || 0;
    const revenue = parseFloat(salesRow?.revenue) || 0;
    const soldCost = parseFloat(salesRow?.cost) || 0;
    const daysSince = (d) => {
      if (!d) return null;
      const t = new Date(`${String(d).slice(0, 10)}T12:00:00`).getTime();
      return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
    };

    const { page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(1000, Math.max(1, parseInt(limit) || 25));
    const movements = inRange.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({
      success: true,
      data: {
        movements,
        pagination: { total: inRange.length, page: pageNum, limit: limitNum, pages: Math.ceil(inRange.length / limitNum) },
        product: {
          id: product.id,
          name: product.name,
          sku: product.sku,
          current_stock: stock,
          min_stock: parseFloat(product.min_stock) || 0,
          average_cost: avgCost,
          last_purchase_cost: parseFloat(product.last_purchase_cost) || 0,
          last_purchase_date: product.last_purchase_date || null,
          days_since_last_purchase: daysSince(product.last_purchase_date),
          sale_price: price,
          price_includes_tax: !!product.price_includes_tax,
          configured_margin_pct: product.profit_margin_percentage !== null && product.profit_margin_percentage !== undefined
            ? parseFloat(product.profit_margin_percentage) : null,
          // Utilidad del precio actual sobre el costo promedio, con el método del tenant.
          current_margin_pct: impliedMargin(avgCost, price, product, method),
          margin_method: method,
          inventory_value: r2(stock * avgCost),
        },
        sales: {
          sales_count: salesRow?.sales_count || 0,
          qty_sold: parseFloat(salesRow?.qty) || 0,
          revenue: r2(revenue),
          cost: r2(soldCost),
          profit: r2(revenue - soldCost),
          // Utilidad realizada sobre la venta (ingreso sin IVA).
          realized_margin_pct: revenue > 0 ? r2(((revenue - soldCost) / revenue) * 100) : null,
          last_sale: lastSale ? { ...lastSale, days_ago: daysSince(lastSale.sale_date) } : null,
        },
        summary: {
          total_movements: inRange.length,
          opening_qty: opening.qty,
          opening_value: opening.value,
          total_entradas: totals.in_qty,
          total_salidas: totals.out_qty,
          valor_entradas: r2(totals.in_value),
          valor_salidas: r2(totals.out_value),
          closing_qty: r2(qty),
          closing_value: r2(value),
          // Compatibilidad con la vista anterior.
          stock_actual: r2(qty),
          total_costo_entradas: r2(totals.in_value),
          costo_promedio: totals.in_qty > 0 ? r2(totals.in_value / totals.in_qty) : 0,
        },
      },
    });
  } catch (error) {
    console.error('Error en getProductKardex:', error);
    res.status(500).json({ success: false, message: 'Error al obtener kardex del producto' });
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
    productChanges.average_cost = weightedAverageCost(previous_stock, product.average_cost, quantity, unit_cost);
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