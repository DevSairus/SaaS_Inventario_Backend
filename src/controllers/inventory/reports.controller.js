const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
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

    // Determinar filtro de fecha: rango personalizado o período en meses
    const dateFilter = from_date && to_date
      ? `movement_date BETWEEN '${from_date}' AND '${to_date} 23:59:59'`
      : `movement_date >= NOW() - INTERVAL '${parseInt(months || 6)} months'`;

    const dateFilterWithAlias = from_date && to_date
      ? `im.movement_date BETWEEN '${from_date}' AND '${to_date} 23:59:59'`
      : `im.movement_date >= NOW() - INTERVAL '${parseInt(months || 6)} months'`;

    // Consulta para cantidades y conteo de movimientos
    const quantityQuery = `
      SELECT 
        TO_CHAR(movement_date, 'YYYY-MM') as month,
        movement_type,
        SUM(quantity)::numeric as total_quantity,
        COUNT(*)::integer as total_movements
      FROM inventory_movements
      WHERE tenant_id = :tenantId
        AND ${dateFilter}
      GROUP BY TO_CHAR(movement_date, 'YYYY-MM'), movement_type
      ORDER BY month DESC
    `;

    // Consulta para valores monetarios (basado en precio promedio del producto)
    const valueQuery = `
      SELECT 
        TO_CHAR(im.movement_date, 'YYYY-MM') as month,
        im.movement_type,
        SUM(im.quantity * p.average_cost)::numeric as total_value
      FROM inventory_movements im
      INNER JOIN products p ON im.product_id = p.id
      WHERE im.tenant_id = :tenantId
        AND ${dateFilterWithAlias}
      GROUP BY TO_CHAR(im.movement_date, 'YYYY-MM'), im.movement_type
      ORDER BY month DESC
    `;

    const [quantities, values] = await Promise.all([
      sequelize.query(quantityQuery, {
        replacements: { tenantId },
        type: QueryTypes.SELECT
      }),
      sequelize.query(valueQuery, {
        replacements: { tenantId },
        type: QueryTypes.SELECT
      })
    ]);

    // Crear un mapa de valores
    const valueMap = {};
    values.forEach(v => {
      const key = `${v.month}-${v.movement_type}`;
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
      const valueKey = `${mov.month}-${mov.movement_type}`;
      const value = valueMap[valueKey] || 0;

      const typeKeyMap = {
        'entrada': 'entradas',
        'salida': 'salidas',
        'ajuste_positivo': 'ajuste_positivo',
        'ajuste_negativo': 'ajuste_negativo'
      };
      const mappedKey = typeKeyMap[mov.movement_type] || mov.movement_type;
      monthsMap[mov.month][mappedKey] = quantity;

      monthsMap[mov.month].total_movements += movementCount;

      if (mov.movement_type === 'entrada') {
        monthsMap[mov.month].entradas_valor = value;
      } else if (mov.movement_type === 'salida') {
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
      error: error.message
    });
  }
};

/**
 * Obtiene valorización de inventario por categoría
 */
exports.getValuation = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    const query = `
      SELECT 
        c.id,
        c.name as category_name,
        COUNT(p.id)::integer as product_count,
        COALESCE(SUM(p.current_stock), 0)::numeric as total_stock,
        COALESCE(SUM(p.current_stock * p.sale_price), 0)::numeric as total_value
      FROM categories c
      LEFT JOIN products p ON c.id = p.category_id AND p.tenant_id = :tenantId
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
      error: error.message
    });
  }
};

/**
 * Obtiene reporte de ganancia por producto
 */
exports.getProfitReport = async (req, res) => {
  try {
    const { months, from_date, to_date, limit = 100 } = req.query;
    const tenantId = req.user.tenant_id;

    // Determinar el filtro de fecha
    let dateFilter;
    if (from_date && to_date) {
      // Usar fechas personalizadas
      dateFilter = `s.sale_date BETWEEN '${from_date}' AND '${to_date}'`;
    } else {
      // Usar meses
      const monthsToUse = months || 3;
      dateFilter = `s.sale_date >= NOW() - INTERVAL '${parseInt(monthsToUse)} months'`;
    }

    const query = `
      SELECT 
        p.id,
        p.name as product_name,
        p.sku as product_sku,
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
      FROM products p
      INNER JOIN sale_items si ON p.id = si.product_id
      INNER JOIN sales s ON si.sale_id = s.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.tenant_id = :tenantId
        AND s.tenant_id = :tenantId
        AND ${dateFilter}
        AND s.status IN ('completed', 'pending')
        AND s.payment_status IN ('paid', 'partial')
      GROUP BY p.id, p.name, p.sku, c.name
      ORDER BY profit DESC
      LIMIT ${parseInt(limit)}
    `;

    const products = await sequelize.query(query, {
      replacements: { tenantId },
      type: QueryTypes.SELECT
    });

    // Calcular totales con valores seguros
    const totals = {
      total_revenue: 0,
      total_cost: 0,
      total_profit: 0,
      margin_percentage: 0
    };

    products.forEach(item => {
      const revenue = parseFloat(item.total_revenue) || 0;
      const cost = parseFloat(item.total_cost) || 0;
      const profit = parseFloat(item.profit) || 0;
      const margin = parseFloat(item.margin_percentage) || 0;
      
      totals.total_revenue += revenue;
      totals.total_cost += cost;
      totals.total_profit += profit;
      
      // Asegurar que los valores en el array sean números válidos
      item.total_quantity = parseFloat(item.total_quantity) || 0;
      item.total_revenue = revenue;
      item.total_cost = cost;
      item.profit = profit;
      item.margin_percentage = margin;
    });

    // Calcular margen promedio
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
      error: error.message
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

    // Construir filtro de fecha dinámico
    const dateFilter = from_date && to_date
      ? `s.sale_date BETWEEN '${from_date}' AND '${to_date} 23:59:59'`
      : `s.sale_date >= NOW() - INTERVAL '${parseInt(months)} months'`;

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
        COALESCE(COUNT(DISTINCT s.id), 0)::integer as sales_count,
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
      FROM products p
      LEFT JOIN (
        SELECT si.product_id, si.quantity, si.unit_price, si.sale_id
        FROM sale_items si
        INNER JOIN sales s ON si.sale_id = s.id
          AND s.status IN ('completed', 'pending')
          AND s.payment_status IN ('paid', 'partial')
          AND s.tenant_id = :tenantId
          AND ${dateFilter}
      ) si ON p.id = si.product_id
      LEFT JOIN sales s ON si.sale_id = s.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.tenant_id = :tenantId
        AND p.product_type != 'service'
      GROUP BY p.id, p.name, p.sku, c.name, p.current_stock, p.min_stock
      ORDER BY qty_sold DESC
    `;

    const allProducts = await sequelize.query(query, {
      replacements: { tenantId },
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
      error: error.message
    });
  }
};