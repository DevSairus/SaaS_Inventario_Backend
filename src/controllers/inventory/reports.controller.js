const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { resolveBranchFilter } = require('../../utils/branchFilter');
const { getCurrentSchema } = require('../../config/tenantContext');
// Sin calificar schema, las 7 queries de este archivo siempre leían "public"
// -- para un tenant ya cortado a su propio schema, todos estos reportes de
// inventario salían vacíos (o en cero) sin ningún error visible.

// ── Helpers de seguridad para parámetros de query ────────────────────────────
const isValidDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
const safeMonths  = (m) => Math.max(1, Math.min(60, parseInt(m) || 6));
const Sale = require('../../models/sales/Sale');
const SaleItem = require('../../models/sales/SaleItem');
const Product = require('../../models/inventory/Product');
const Category = require('../../models/inventory/Category');
const InventoryMovement = require('../../models/inventory/InventoryMovement');
const Purchase = require('../../models/inventory/Purchase');
const PurchaseItem = require('../../models/inventory/PurchaseItem');

exports.getMovementsByMonth = async (req, res) => {
  try {
    const { months, from_date, to_date } = req.query;
    const tenantId = req.user.tenant_id;

    // Para roles no-admin, se ignora el branch_id de query y se fuerza la
    // sede autorizada del usuario (ver utils/branchFilter.js).
    const branch_id = resolveBranchFilter(req);

    // Validar fechas
    if (from_date && !isValidDate(from_date)) {
      return res.status(400).json({ success: false, message: 'from_date inválido. Use formato YYYY-MM-DD' });
    }
    if (to_date && !isValidDate(to_date)) {
      return res.status(400).json({ success: false, message: 'to_date inválido. Use formato YYYY-MM-DD' });
    }
    const safeM = safeMonths(months);

    // Determinar filtro de fecha: rango personalizado o período en meses
    const dateFilter = from_date && to_date
      ? `movement_date BETWEEN :fromDate AND :toDate`
      : `movement_date >= NOW() - INTERVAL '${safeM} months'`;

    const dateFilterWithAlias = from_date && to_date
      ? `im.movement_date BETWEEN :fromDate AND :toDate`
      : `im.movement_date >= NOW() - INTERVAL '${safeM} months'`;

    // inventory_movements no tiene columna branch_id propia (el inventario es
    // global/compartido entre sedes), pero como 1 sede = 1 bodega (decisión de
    // diseño de Fase 1), filtrar por sede equivale a filtrar por su bodega.
    const branchFilter = branch_id ? `AND warehouse_id = :branchWarehouseId` : '';
    const branchFilterWithAlias = branch_id ? `AND im.warehouse_id = :branchWarehouseId` : '';

    const schema = getCurrentSchema() || 'public';

    let branchWarehouseId = null;
    if (branch_id) {
      const [warehouseRow] = await sequelize.query(
        `SELECT id FROM "${schema}"."warehouses" WHERE tenant_id = :tenantId AND branch_id = :branchId LIMIT 1`,
        { replacements: { tenantId, branchId: branch_id }, type: QueryTypes.SELECT }
      );
      // Si la sede no tiene bodega asociada, usamos un id inexistente para
      // devolver resultados vacíos en lugar de ignorar el filtro.
      branchWarehouseId = warehouseRow ? warehouseRow.id : '00000000-0000-0000-0000-000000000000';
    }

    // Consulta para cantidades y conteo de movimientos
    // OJO: se agrupa por "direction" ('in'/'out'), NO por "movement_type" —
    // ese campo guarda la clasificación de negocio (sale, purchase, etc.),
    // no 'entrada'/'salida'. Ver nota en movements.controller.js.
    const quantityQuery = `
      SELECT 
        TO_CHAR(movement_date, 'YYYY-MM') as month,
        direction,
        SUM(quantity)::numeric as total_quantity,
        COUNT(*)::integer as total_movements
      FROM "${schema}"."inventory_movements"
      WHERE tenant_id = :tenantId
        AND ${dateFilter}
        ${branchFilter}
      GROUP BY TO_CHAR(movement_date, 'YYYY-MM'), direction
      ORDER BY month DESC
    `;

    // Consulta para valores monetarios (basado en precio promedio del producto)
    const valueQuery = `
      SELECT 
        TO_CHAR(im.movement_date, 'YYYY-MM') as month,
        im.direction,
        SUM(im.quantity * p.average_cost)::numeric as total_value
      FROM "${schema}"."inventory_movements" im
      INNER JOIN "${schema}"."products" p ON im.product_id = p.id
      WHERE im.tenant_id = :tenantId
        AND ${dateFilterWithAlias}
        ${branchFilterWithAlias}
      GROUP BY TO_CHAR(im.movement_date, 'YYYY-MM'), im.direction
      ORDER BY month DESC
    `;

    const dateReplacements = from_date && to_date ? { fromDate: from_date, toDate: to_date } : {};
    const branchReplacements = branch_id ? { branchWarehouseId } : {};

    const [quantities, values] = await Promise.all([
      sequelize.query(quantityQuery, {
        replacements: { tenantId, ...dateReplacements, ...branchReplacements },
        type: QueryTypes.SELECT
      }),
      sequelize.query(valueQuery, {
        replacements: { tenantId, ...dateReplacements, ...branchReplacements },
        type: QueryTypes.SELECT
      })
    ]);

    // Crear un mapa de valores
    const valueMap = {};
    values.forEach(v => {
      const key = `${v.month}-${v.direction}`;
      valueMap[key] = parseFloat(v.total_value) || 0;
    });

    const monthsMap = {};
    quantities.forEach(mov => {
      if (!monthsMap[mov.month]) {
        monthsMap[mov.month] = {
          month: mov.month,
          entradas: 0,
          salidas: 0,
          ajuste_positivo: 0,
          ajuste_negativo: 0,
          entradas_valor: 0,
          salidas_valor: 0,
          total_movements: 0
        };
      }

      const quantity = parseFloat(mov.total_quantity) || 0;
      const movementCount = parseInt(mov.total_movements) || 0;
      const valueKey = `${mov.month}-${mov.direction}`;
      const value = valueMap[valueKey] || 0;

      const typeKeyMap = {
        'in': 'entradas',
        'out': 'salidas'
      };
      const mappedKey = typeKeyMap[mov.direction] || mov.direction;
      monthsMap[mov.month][mappedKey] = quantity;

      monthsMap[mov.month].total_movements += movementCount;

      if (mov.direction === 'in') {
        monthsMap[mov.month].entradas_valor = value;
      } else if (mov.direction === 'out') {
        monthsMap[mov.month].salidas_valor = value;
      }
    });

    const data = Object.values(monthsMap).sort((a, b) =>
      a.month.localeCompare(b.month)
    );

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en getMovementsByMonth:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener reporte de movimientos',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Obtiene valorización de inventario por categoría
 */
exports.getValuation = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const schema = getCurrentSchema() || 'public';

    const query = `
      SELECT 
        c.id,
        c.name as category_name,
        COUNT(p.id)::integer as product_count,
        COALESCE(SUM(p.current_stock), 0)::numeric as total_stock,
        COALESCE(SUM(p.current_stock * p.sale_price), 0)::numeric as total_value
      FROM "${schema}"."categories" c
      LEFT JOIN "${schema}"."products" p ON c.id = p.category_id AND p.tenant_id = :tenantId
      WHERE c.tenant_id = :tenantId
      GROUP BY c.id, c.name
      ORDER BY total_value DESC
    `;

    const by_category = await sequelize.query(query, {
      replacements: { tenantId },
      type: QueryTypes.SELECT
    });

    // Calcular totales con valores por defecto seguros
    const totals = {
      product_count: 0,
      total_stock: 0,
      total_value: 0
    };

    by_category.forEach(item => {
      const productCount = parseInt(item.product_count) || 0;
      const totalStock = parseFloat(item.total_stock) || 0;
      const totalValue = parseFloat(item.total_value) || 0;
      
      totals.product_count += productCount;
      totals.total_stock += totalStock;
      totals.total_value += totalValue;
      
      // Asegurar que los valores en el array sean números válidos
      item.product_count = productCount;
      item.total_stock = totalStock;
      item.total_value = totalValue;
    });

    res.json({
      success: true,
      data: {
        by_category,
        totals
      }
    });
  } catch (error) {
    console.error('Error en getValuation:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener valorización',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Obtiene reporte de ganancia por producto físico Y por mano de obra/servicios.
 *
 * Los productos físicos (repuestos) usan su costo real (unit_cost snapshot o
 * average_cost). La mano de obra NO puede usar sale_items.unit_cost -- ese
 * campo siempre queda en 0 para ítems de servicio (ver workOrders.controller.js,
 * generación de la Sale al cerrar una OT), lo que antes hacía que el margen de
 * "Servicios" mostrara ~100% siempre. Ahora la mano de obra se calcula desde
 * work_order_items usando laborCost.service.js: costo REAL si la OT ya fue
 * liquidada (commission_settlement_items), costo ESTIMADO (% configurable del
 * tenant) si aún no. Cada fila trae cost_source para que el frontend distinga
 * cifras reales de estimadas.
 */
exports.getProfitReport = async (req, res) => {
  try {
    const { months, from_date, to_date, limit = 100 } = req.query;
    const tenantId = req.user.tenant_id;
    const schema = getCurrentSchema() || 'public';

    // Para roles no-admin, se ignora el branch_id de query y se fuerza la
    // sede autorizada del usuario (ver utils/branchFilter.js).
    const branch_id = resolveBranchFilter(req);

    // ── Validar fechas — prevenir SQL injection ───────────────────────────
    if (from_date && !isValidDate(from_date)) {
      return res.status(400).json({ success: false, message: 'from_date inválido. Use formato YYYY-MM-DD' });
    }
    if (to_date && !isValidDate(to_date)) {
      return res.status(400).json({ success: false, message: 'to_date inválido. Use formato YYYY-MM-DD' });
    }
    const safeLimit = Math.max(1, Math.min(500, parseInt(limit) || 100));

    let dateFilter;
    let woDateFilter;
    if (from_date && to_date) {
      dateFilter = `COALESCE(s.sale_date, s.created_at) BETWEEN :fromDate AND :toDate`;
      woDateFilter = `COALESCE(wo.delivered_at, wo.created_at) BETWEEN :fromDate AND :toDate`;
    } else {
      const monthsToUse = safeMonths(months || 3);
      dateFilter = `COALESCE(s.sale_date, s.created_at) >= NOW() - INTERVAL '${monthsToUse} months'`;
      woDateFilter = `COALESCE(wo.delivered_at, wo.created_at) >= NOW() - INTERVAL '${monthsToUse} months'`;
    }

    // sales.branch_id ya existe (Fase 1/2), a diferencia de inventory_movements
    // no requiere lookup a warehouses.
    const branchFilter = branch_id ? `AND s.branch_id = :branchId` : '';

    // work_orders no tiene branch_id propio (1 sede = 1 bodega) — resolver vía
    // warehouse_id, mismo criterio que getMovementsByMonth.
    let branchWarehouseId = null;
    if (branch_id) {
      const [warehouseRow] = await sequelize.query(
        `SELECT id FROM "${schema}"."warehouses" WHERE tenant_id = :tenantId AND branch_id = :branchId LIMIT 1`,
        { replacements: { tenantId, branchId: branch_id }, type: QueryTypes.SELECT }
      );
      branchWarehouseId = warehouseRow ? warehouseRow.id : '00000000-0000-0000-0000-000000000000';
    }
    const woBranchFilter = branch_id ? `AND wo.warehouse_id = :branchWarehouseId` : '';

    const dateReplacements = from_date && to_date ? { fromDate: from_date, toDate: to_date } : {};
    const branchReplacements = branch_id ? { branchId: branch_id, branchWarehouseId } : {};

    // ── Productos físicos (repuestos) — sin cambios de fondo, solo se
    // excluye explícitamente product_type='service' para no mezclarlo con la
    // rama de mano de obra de abajo ────────────────────────────────────────
    const query = `
      SELECT
        p.id,
        p.name as product_name,
        p.sku as product_sku,
        p.product_type,
        c.name as category,
        COUNT(DISTINCT s.id)::integer as total_sales,
        COALESCE(SUM(si.quantity), 0)::numeric as total_quantity,
        COALESCE(SUM(si.quantity * si.unit_price), 0)::numeric as total_revenue,
        COALESCE(SUM(si.quantity * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END), 0)::numeric as total_cost,
        COALESCE(SUM(si.quantity * (si.unit_price - CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END)), 0)::numeric as profit,
        ROUND(
          CASE
            WHEN SUM(si.quantity * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END) > 0 THEN
              SUM(si.quantity * (si.unit_price - CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END))
              / SUM(si.quantity * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END) * 100
            ELSE 0
          END,
          2
        )::numeric as margin_percentage
      FROM "${schema}"."products" p
      INNER JOIN "${schema}"."sale_items" si ON p.id = si.product_id
      INNER JOIN "${schema}"."sales" s ON si.sale_id = s.id
      LEFT JOIN "${schema}"."categories" c ON p.category_id = c.id
      WHERE p.tenant_id = :tenantId
        AND s.tenant_id = :tenantId
        AND p.product_type != 'service'
        AND ${dateFilter}
        AND s.status IN ('completed', 'pending')
        ${branchFilter}
      GROUP BY p.id, p.name, p.sku, p.product_type, c.name
      ORDER BY profit DESC
      LIMIT ${parseInt(limit)}
    `;

    const physicalProducts = await sequelize.query(query, {
      replacements: { tenantId, ...dateReplacements, ...branchReplacements },
      type: QueryTypes.SELECT
    });

    const totalsQuery = `
      SELECT
        COALESCE(SUM(si.quantity * si.unit_price), 0)::numeric as total_revenue,
        COALESCE(SUM(si.quantity * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END), 0)::numeric as total_cost,
        COALESCE(SUM(si.quantity * (si.unit_price - CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END)), 0)::numeric as total_profit
      FROM "${schema}"."products" p
      INNER JOIN "${schema}"."sale_items" si ON p.id = si.product_id
      INNER JOIN "${schema}"."sales" s ON si.sale_id = s.id
      WHERE p.tenant_id = :tenantId
        AND s.tenant_id = :tenantId
        AND p.product_type != 'service'
        AND ${dateFilter}
        AND s.status IN ('completed', 'pending')
        ${branchFilter}
    `;
    const [physicalTotalsRow] = await sequelize.query(totalsQuery, {
      replacements: { tenantId, ...dateReplacements, ...branchReplacements },
      type: QueryTypes.SELECT
    });

    physicalProducts.forEach(item => {
      item.total_quantity = parseFloat(item.total_quantity) || 0;
      item.total_revenue = parseFloat(item.total_revenue) || 0;
      item.total_cost = parseFloat(item.total_cost) || 0;
      item.profit = parseFloat(item.profit) || 0;
      item.margin_percentage = parseFloat(item.margin_percentage) || 0;
    });

    // ── Mano de obra / servicios — desde work_order_items, con costo real
    // (liquidado) o estimado (% del tenant) por OT ──────────────────────────
    const laborItemsQuery = `
      SELECT wo.id as work_order_id,
        woi.product_name, woi.product_sku,
        COALESCE(woi.quantity, 0)::numeric as quantity,
        COALESCE(woi.unit_price, 0)::numeric as unit_price
      FROM "${schema}"."work_orders" wo
      INNER JOIN "${schema}"."work_order_items" woi ON woi.work_order_id = wo.id
      WHERE wo.tenant_id = :tenantId
        AND woi.item_type IN ('servicio', 'mano_obra')
        AND wo.status = 'entregado'
        AND ${woDateFilter}
        ${woBranchFilter}
    `;
    const laborItems = await sequelize.query(laborItemsQuery, {
      replacements: { tenantId, ...dateReplacements, ...branchReplacements },
      type: QueryTypes.SELECT
    });

    const { getLaborCostByWorkOrderIds, resolveLaborCost } = require('../../services/workshop/laborCost.service');

    const otRevenue = new Map();
    for (const it of laborItems) {
      const revenue = (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0);
      otRevenue.set(it.work_order_id, (otRevenue.get(it.work_order_id) || 0) + revenue);
    }
    const workOrderIds = Array.from(otRevenue.keys());
    const { pct, settledMap } = await getLaborCostByWorkOrderIds(tenantId, workOrderIds);

    // Agregar por nombre de ítem para mostrar una tabla legible (equivalente
    // a "por producto" para productos físicos), prorrateando el costo de la
    // OT proporcionalmente al ingreso de cada línea dentro de esa OT.
    const laborGroups = new Map();
    let laborCostReal = 0;
    let laborCostEstimated = 0;

    for (const it of laborItems) {
      const revenue = (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0);
      const otTotalRevenue = otRevenue.get(it.work_order_id) || 0;
      const { labor_cost: otLaborCost, is_real } = resolveLaborCost(it.work_order_id, otTotalRevenue, settledMap, pct);
      const itemCost = otTotalRevenue > 0 ? (revenue / otTotalRevenue) * otLaborCost : 0;

      if (is_real) laborCostReal += itemCost; else laborCostEstimated += itemCost;

      const key = it.product_name || 'Mano de obra';
      if (!laborGroups.has(key)) {
        laborGroups.set(key, {
          id: `labor:${key}`,
          product_name: key,
          product_sku: it.product_sku || null,
          product_type: 'service',
          category: 'Mano de obra',
          total_sales: new Set(),
          total_quantity: 0,
          total_revenue: 0,
          total_cost: 0,
          has_real: false,
          has_estimated: false,
        });
      }
      const g = laborGroups.get(key);
      g.total_sales.add(it.work_order_id);
      g.total_quantity += parseFloat(it.quantity) || 0;
      g.total_revenue += revenue;
      g.total_cost += itemCost;
      if (is_real) g.has_real = true; else g.has_estimated = true;
    }

    const laborProducts = Array.from(laborGroups.values()).map(g => {
      const profit = g.total_revenue - g.total_cost;
      return {
        id: g.id,
        product_name: g.product_name,
        product_sku: g.product_sku,
        product_type: g.product_type,
        category: g.category,
        total_sales: g.total_sales.size,
        total_quantity: g.total_quantity,
        total_revenue: g.total_revenue,
        total_cost: g.total_cost,
        profit,
        margin_percentage: g.total_cost > 0 ? (profit / g.total_cost) * 100 : 0,
        cost_source: g.has_real && g.has_estimated ? 'mixto' : (g.has_real ? 'real' : 'estimado'),
      };
    }).sort((a, b) => b.profit - a.profit);

    const laborRevenueTotal = laborProducts.reduce((s, p) => s + p.total_revenue, 0);
    const laborCostTotal = laborCostReal + laborCostEstimated;
    const laborProfitTotal = laborRevenueTotal - laborCostTotal;

    // ── Merge física + mano de obra ─────────────────────────────────────────
    const products = [...physicalProducts, ...laborProducts].sort((a, b) => b.profit - a.profit);

    const totals = {
      total_revenue: (parseFloat(physicalTotalsRow?.total_revenue) || 0) + laborRevenueTotal,
      total_cost: (parseFloat(physicalTotalsRow?.total_cost) || 0) + laborCostTotal,
      total_profit: (parseFloat(physicalTotalsRow?.total_profit) || 0) + laborProfitTotal,
      margin_percentage: 0,
      labor_cost_real: laborCostReal,
      labor_cost_estimated: laborCostEstimated,
      // % del costo de mano de obra que es estimado (no liquidado todavía) —
      // úsese para avisar en el frontend cuando el margen de servicios es
      // en su mayoría una aproximación, no un dato real.
      pct_estimated: laborCostTotal > 0 ? (laborCostEstimated / laborCostTotal) * 100 : 0,
      default_labor_cost_percentage: pct,
    };
    if (totals.total_cost > 0) {
      totals.margin_percentage = (totals.total_profit / totals.total_cost) * 100;
    }

    res.json({
      success: true,
      data: {
        products,
        totals
      }
    });
  } catch (error) {
    console.error('Error en getProfitReport:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener reporte de ganancias',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Obtiene reporte de rotación de inventario
 */
exports.getRotationReport = async (req, res) => {
  try {
    const { months = 3, from_date, to_date } = req.query;
    const tenantId = req.user.tenant_id;
    const schema = getCurrentSchema() || 'public';

    // Para roles no-admin, se ignora el branch_id de query y se fuerza la
    // sede autorizada del usuario (ver utils/branchFilter.js).
    const branch_id = resolveBranchFilter(req);

    // ── Validar fechas — prevenir SQL injection ───────────────────────────
    if (from_date && !isValidDate(from_date)) {
      return res.status(400).json({ success: false, message: 'from_date inválido. Use formato YYYY-MM-DD' });
    }
    if (to_date && !isValidDate(to_date)) {
      return res.status(400).json({ success: false, message: 'to_date inválido. Use formato YYYY-MM-DD' });
    }

    // Construir filtro de fecha dinámico
    const dateFilter = from_date && to_date
      ? `s.sale_date BETWEEN :fromDate AND :toDate`
      : `s.sale_date >= NOW() - INTERVAL '${safeMonths(months)} months'`;

    // sales.branch_id ya existe; el subquery de ventas de la sección de
    // rotación filtra sobre esa tabla directamente.
    const branchFilter = branch_id ? `AND branch_id = :branchId` : '';

    const query = `
      SELECT 
        p.id,
        p.name as product_name,
        p.sku,
        c.name as category,
        COALESCE(p.current_stock, 0)::numeric as current_stock,
        COALESCE(p.min_stock, 0)::numeric as min_stock,
        COALESCE(SUM(si.quantity), 0)::numeric as qty_sold,
        COALESCE(SUM(si.quantity * si.unit_price), 0)::numeric as revenue,
        COALESCE(COUNT(DISTINCT si.sale_id), 0)::integer as sales_count,
        ROUND(
          COALESCE(SUM(si.quantity), 0) / NULLIF(p.current_stock, 0),
          2
        )::numeric as rotation_rate,
        CASE
          WHEN COALESCE(p.current_stock, 0) = 0 THEN 'Sin stock'
          WHEN COALESCE(SUM(si.quantity), 0) = 0 THEN 'Sin movimiento'
          WHEN COALESCE(SUM(si.quantity), 0) / NULLIF(p.current_stock, 0) > 2 THEN 'Alta rotación'
          WHEN COALESCE(SUM(si.quantity), 0) / NULLIF(p.current_stock, 0) > 1 THEN 'Media rotación'
          ELSE 'Baja rotación'
        END as rotation_status
      FROM "${schema}"."products" p
      LEFT JOIN "${schema}"."sale_items" si ON p.id = si.product_id
        AND si.sale_id IN (
          SELECT id FROM "${schema}"."sales"
          WHERE tenant_id = :tenantId
            AND status IN ('completed')
            AND ${dateFilter.replace('s.sale_date', 'sale_date')}
            ${branchFilter}
        )
      LEFT JOIN "${schema}"."categories" c ON p.category_id = c.id
      WHERE p.tenant_id = :tenantId
        AND p.product_type != 'service'
      GROUP BY p.id, p.name, p.sku, c.name, p.current_stock, p.min_stock
      ORDER BY qty_sold DESC
    `;

    const dateReplacements = from_date && to_date ? { fromDate: from_date, toDate: to_date } : {};
    const branchReplacements = branch_id ? { branchId: branch_id } : {};

    const allProducts = await sequelize.query(query, {
      replacements: { tenantId, ...dateReplacements, ...branchReplacements },
      type: QueryTypes.SELECT
    });

    // Asegurar que todos los valores numéricos sean válidos
    allProducts.forEach(item => {
      item.current_stock = parseFloat(item.current_stock) || 0;
      item.min_stock = parseFloat(item.min_stock) || 0;
      item.qty_sold = parseFloat(item.qty_sold) || 0;
      item.revenue = parseFloat(item.revenue) || 0;
      item.sales_count = parseInt(item.sales_count) || 0;
      item.rotation_rate = parseFloat(item.rotation_rate) || 0;
    });

    // Alta rotación: productos con ventas, ordenados por qty_sold desc (top 10 más vendidos)
    const high_rotation = allProducts
      .filter(p => p.qty_sold > 0)
      .slice(0, 10);

    // Baja rotación: productos sin ventas en el período, ordenados por stock desc
    const low_rotation = allProducts
      .filter(p => p.qty_sold === 0 && p.current_stock > 0)
      .sort((a, b) => b.current_stock - a.current_stock)
      .slice(0, 10);

    // Calcular estadísticas
    const total_products = allProducts.length;
    const products_with_sales = allProducts.filter(p => p.qty_sold > 0).length;
    const products_without_sales = allProducts.filter(p => p.qty_sold === 0).length;

    res.json({
      success: true,
      data: {
        high_rotation,
        low_rotation,
        total_products,
        products_with_sales,
        products_without_sales
      }
    });
  } catch (error) {
    console.error('Error en getRotationReport:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener reporte de rotación',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Rentabilidad consolidada del taller para un período:
 *   Utilidad Neta = Ingresos - Costo de repuestos (COGS) - Costo de mano de
 *                   obra (real+estimado) - Gastos operativos
 *
 * Se agrega directo de las tablas fuente (Sale, work_order_items,
 * commission_settlement_items, Expense) en vez de depender del libro
 * contable -- éste no está garantizado completo si algún evento no generó
 * asiento (mapeo faltante), así que no es una fuente confiable para este
 * número gerencial.
 *
 * OJO — evitar doble conteo: operating_expenses EXCLUYE la categoría
 * 'comisiones_tecnicos' porque esa comisión ya está contada dentro de
 * labor_cost (vía commission_settlement_items). Sumarla también aquí
 * duplicaría el costo de mano de obra ya liquidado.
 */
exports.getProfitabilityReport = async (req, res) => {
  try {
    const { months, from_date, to_date } = req.query;
    const tenantId = req.user.tenant_id;
    const schema = getCurrentSchema() || 'public';
    const branch_id = resolveBranchFilter(req);

    if (from_date && !isValidDate(from_date)) {
      return res.status(400).json({ success: false, message: 'from_date inválido. Use formato YYYY-MM-DD' });
    }
    if (to_date && !isValidDate(to_date)) {
      return res.status(400).json({ success: false, message: 'to_date inválido. Use formato YYYY-MM-DD' });
    }

    const monthsToUse = safeMonths(months || 3);
    const saleDateFilter = from_date && to_date
      ? `COALESCE(s.sale_date, s.created_at) BETWEEN :fromDate AND :toDate`
      : `COALESCE(s.sale_date, s.created_at) >= NOW() - INTERVAL '${monthsToUse} months'`;
    const expenseDateFilter = from_date && to_date
      ? `e.expense_date BETWEEN :fromDate AND :toDate`
      : `e.expense_date >= NOW() - INTERVAL '${monthsToUse} months'`;

    const branchFilter = branch_id ? `AND s.branch_id = :branchId` : '';
    const expenseBranchFilter = branch_id ? `AND (e.branch_id = :branchId OR e.branch_id IS NULL)` : '';

    let branchWarehouseId = null;
    if (branch_id) {
      const [warehouseRow] = await sequelize.query(
        `SELECT id FROM "${schema}"."warehouses" WHERE tenant_id = :tenantId AND branch_id = :branchId LIMIT 1`,
        { replacements: { tenantId, branchId: branch_id }, type: QueryTypes.SELECT }
      );
      branchWarehouseId = warehouseRow ? warehouseRow.id : '00000000-0000-0000-0000-000000000000';
    }

    const dateReplacements = from_date && to_date ? { fromDate: from_date, toDate: to_date } : {};

    // Ingresos totales (la OT ya generó su Sale al entregarse, así que sumar
    // solo Sale evita contar dos veces el mismo ingreso)
    const [revenueRow] = await sequelize.query(
      `
        SELECT COALESCE(SUM(s.total_amount), 0)::numeric as total_revenue
        FROM "${schema}"."sales" s
        WHERE s.tenant_id = :tenantId
          AND s.status IN ('completed', 'pending')
          AND ${saleDateFilter}
          ${branchFilter}
      `,
      { replacements: { tenantId, ...dateReplacements, branchId: branch_id }, type: QueryTypes.SELECT }
    );

    // Costo de repuestos (COGS) — misma fórmula que getProfitReport
    const [partsCostRow] = await sequelize.query(
      `
        SELECT COALESCE(SUM(si.quantity * CASE WHEN si.unit_cost > 0 THEN si.unit_cost ELSE COALESCE(p.average_cost, 0) END), 0)::numeric as parts_cost
        FROM "${schema}"."products" p
        INNER JOIN "${schema}"."sale_items" si ON p.id = si.product_id
        INNER JOIN "${schema}"."sales" s ON si.sale_id = s.id
        WHERE p.tenant_id = :tenantId
          AND s.tenant_id = :tenantId
          AND p.product_type != 'service'
          AND s.status IN ('completed', 'pending')
          AND ${saleDateFilter}
          ${branchFilter}
      `,
      { replacements: { tenantId, ...dateReplacements, branchId: branch_id }, type: QueryTypes.SELECT }
    );

    // Costo de mano de obra (real + estimado) — mismo criterio de rango que
    // ventas: fecha explícita si se dio, si no los últimos N meses.
    const { getLaborCostForPeriod } = require('../../services/workshop/laborCost.service');
    let laborRangeFrom = from_date;
    let laborRangeTo = to_date;
    if (!(from_date && to_date)) {
      const dFrom = new Date();
      dFrom.setMonth(dFrom.getMonth() - monthsToUse);
      laborRangeFrom = dFrom;
      laborRangeTo = new Date();
    }
    const laborForRange = await getLaborCostForPeriod({
      tenantId, branchWarehouseId, dateFrom: laborRangeFrom, dateTo: laborRangeTo,
    });

    // Gastos operativos, EXCLUYENDO comisiones_tecnicos (ya contadas en labor_cost)
    const [expensesRow] = await sequelize.query(
      `
        SELECT COALESCE(SUM(e.total_amount), 0)::numeric as operating_expenses
        FROM "${schema}"."expenses" e
        WHERE e.tenant_id = :tenantId
          AND e.category != 'comisiones_tecnicos'
          AND ${expenseDateFilter}
          ${expenseBranchFilter}
      `,
      { replacements: { tenantId, ...dateReplacements, branchId: branch_id }, type: QueryTypes.SELECT }
    );

    const total_revenue = parseFloat(revenueRow?.total_revenue) || 0;
    const parts_cost = parseFloat(partsCostRow?.parts_cost) || 0;
    const labor_cost = laborForRange.labor_cost;
    const operating_expenses = parseFloat(expensesRow?.operating_expenses) || 0;
    const net_profit = total_revenue - parts_cost - labor_cost - operating_expenses;

    res.json({
      success: true,
      data: {
        total_revenue,
        parts_cost,
        labor_cost,
        labor_cost_real: laborForRange.labor_cost_real,
        labor_cost_estimated: laborForRange.labor_cost_estimated,
        operating_expenses_excluding_commissions: operating_expenses,
        net_profit,
        net_margin_percentage: total_revenue > 0 ? (net_profit / total_revenue) * 100 : 0,
        default_labor_cost_percentage: laborForRange.default_labor_cost_percentage,
      }
    });
  } catch (error) {
    console.error('Error en getProfitabilityReport:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener reporte de rentabilidad',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};