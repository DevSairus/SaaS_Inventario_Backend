// backend/src/controllers/dashboard.controller.js
const { Product, Sale, SaleItem, Purchase, Customer, InventoryMovement, Warehouse } = require('../models');
const { Op, fn, col, literal } = require('sequelize');

/**
 * Obtener KPIs principales del dashboard
 */
exports.getKPIs = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { period = '30' } = req.query; // días
    
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - parseInt(period));

    // KPI 1: Ventas del período
    const salesStats = await Sale.findOne({
      where: {
        tenant_id: tenantId,
        sale_date: { [Op.gte]: dateFrom },
        status: { [Op.in]: ['completed'] }
      },
      attributes: [
        [fn('COUNT', col('id')), 'count'],
        [fn('SUM', col('total_amount')), 'revenue']
      ],
      raw: true
    });

    // Calcular profit desde los items de venta
    const profitCalc = await SaleItem.findOne({
      where: {
        '$sale.tenant_id$': tenantId,
        '$sale.sale_date$': { [Op.gte]: dateFrom },
        '$sale.status$': { [Op.in]: ['completed'] }
      },
      attributes: [
        [fn('SUM', literal('(unit_price - unit_cost) * quantity')), 'total_profit']
      ],
      include: [{
        model: Sale,
        as: 'sale',
        attributes: [],
        required: true
      }],
      raw: true
    });

    // KPI 2: Ventas de hoy
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaySales = await Sale.findOne({
      where: {
        tenant_id: tenantId,
        sale_date: { [Op.gte]: today },
        status: { [Op.in]: ['completed'] }
      },
      attributes: [
        [fn('COUNT', col('id')), 'count'],
        [fn('SUM', col('total_amount')), 'revenue']
      ],
      raw: true
    });

    // KPI 3: Productos con stock bajo (pero no sin stock)
    const lowStockCount = await Product.count({
      where: {
        tenant_id: tenantId,
        [Op.and]: [
          literal('current_stock <= min_stock'),
          { current_stock: { [Op.gt]: 0 } }
        ],
        is_active: true
      }
    });

    // KPI 4: Valor total del inventario
    const inventoryValue = await Product.findOne({
      where: {
        tenant_id: tenantId,
        is_active: true
      },
      attributes: [
        [fn('SUM', literal('current_stock * average_cost')), 'total_value'],
        [fn('COUNT', col('id')), 'total_products']
      ],
      raw: true
    });

    // KPI 5: Top 5 productos vendidos
    const topProducts = await SaleItem.findAll({
      where: {
        '$sale.tenant_id$': tenantId,
        '$sale.sale_date$': { [Op.gte]: dateFrom },
        '$sale.status$': { [Op.in]: ['completed'] }
      },
      attributes: [
        'product_id',
        [fn('SUM', col('SaleItem.quantity')), 'total_quantity'],
        [fn('SUM', col('SaleItem.subtotal')), 'revenue']
      ],
      include: [
        {
          model: Sale,
          as: 'sale',
          attributes: [],
          required: true
        },
        {
          model: Product,
          as: 'product',
          attributes: ['id', 'name', 'sku']
        }
      ],
      group: ['product_id', 'product.id', 'product.name', 'product.sku'],
      order: [[fn('SUM', col('SaleItem.quantity')), 'DESC']],
      limit: 5,
      raw: false
    });

    // KPI 6: Ventas por día (gráfica)
    const salesByDay = await Sale.findAll({
      where: {
        tenant_id: tenantId,
        sale_date: { [Op.gte]: dateFrom },
        status: { [Op.in]: ['completed'] }
      },
      attributes: [
        [fn('DATE', col('sale_date')), 'date'],
        [fn('COUNT', col('id')), 'count'],
        [fn('SUM', col('total_amount')), 'revenue']
      ],
      group: [fn('DATE', col('sale_date'))],
      order: [[fn('DATE', col('sale_date')), 'ASC']],
      raw: true
    });

    // Calcular profit por día
    const profitByDay = await SaleItem.findAll({
      where: {
        '$sale.tenant_id$': tenantId,
        '$sale.sale_date$': { [Op.gte]: dateFrom },
        '$sale.status$': { [Op.in]: ['completed'] }
      },
      attributes: [
        [fn('DATE', col('sale.sale_date')), 'date'],
        [fn('SUM', literal('(unit_price - unit_cost) * quantity')), 'profit']
      ],
      include: [{
        model: Sale,
        as: 'sale',
        attributes: [],
        required: true
      }],
      group: [fn('DATE', col('sale.sale_date'))],
      order: [[fn('DATE', col('sale.sale_date')), 'ASC']],
      raw: true
    });

    // Combinar salesByDay con profitByDay
    const salesByDayWithProfit = salesByDay.map(day => {
      const profitData = profitByDay.find(p => p.date === day.date);
      return {
        date: day.date,
        count: parseInt(day.count),
        revenue: parseFloat(day.revenue),
        profit: profitData ? parseFloat(profitData.profit) : 0
      };
    });

    const totalProfit = parseFloat(profitCalc?.total_profit || 0);
    const totalRevenue = parseFloat(salesStats?.revenue || 0);

    res.json({
      period: parseInt(period),
      kpis: {
        sales: {
          count: parseInt(salesStats?.count || 0),
          revenue: totalRevenue,
          profit: totalProfit,
          margin: totalRevenue > 0 
            ? ((totalProfit / totalRevenue) * 100).toFixed(2)
            : 0
        },
        today: {
          count: parseInt(todaySales?.count || 0),
          revenue: parseFloat(todaySales?.revenue || 0)
        },
        inventory: {
          total_products: parseInt(inventoryValue?.total_products || 0),
          total_value: parseFloat(inventoryValue?.total_value || 0),
          low_stock_count: lowStockCount
        }
      },
      charts: {
        salesByDay: salesByDayWithProfit,
        topProducts: topProducts
          .filter(item => item.product != null)
          .map(item => ({
            product: {
              id: item.product.id,
              name: item.product.name,
              sku: item.product.sku
            },
            quantity: parseInt(item.dataValues.total_quantity),
            revenue: parseFloat(item.dataValues.revenue)
          }))
      }
    });

  } catch (error) {
    console.error('Error al obtener KPIs:', error);
    res.status(500).json({
      message: 'Error al obtener KPIs del dashboard',
      error: error.message
    });
  }
};

/**
 * Obtener alertas del sistema
 */
exports.getAlerts = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const alerts = [];

    // Alerta 1: Productos con stock bajo
    const lowStockProducts = await Product.findAll({
      where: {
        tenant_id: tenantId,
        [Op.and]: [
          literal('current_stock <= min_stock'),
          { current_stock: { [Op.gt]: 0 } }
        ],
        is_active: true
      },
      attributes: ['id', 'name', 'sku', 'current_stock', 'min_stock'],
      limit: 10
    });

    if (lowStockProducts.length > 0) {
      alerts.push({
        type: 'warning',
        category: 'inventory',
        title: `${lowStockProducts.length} productos con stock bajo`,
        message: 'Productos que necesitan reabastecimiento',
        data: lowStockProducts.map(p => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          current_stock: parseFloat(p.current_stock),
          min_stock: parseFloat(p.min_stock)
        })),
        priority: 'high'
      });
    }

    // Alerta 2: Productos sin stock
    const outOfStockProducts = await Product.findAll({
      where: {
        tenant_id: tenantId,
        current_stock: 0,
        is_active: true
      },
      attributes: ['id', 'name', 'sku'],
      limit: 10
    });

    if (outOfStockProducts.length > 0) {
      alerts.push({
        type: 'error',
        category: 'inventory',
        title: `${outOfStockProducts.length} productos sin stock`,
        message: 'Productos agotados que no se pueden vender',
        data: outOfStockProducts.map(p => ({
          id: p.id,
          name: p.name,
          sku: p.sku
        })),
        priority: 'critical'
      });
    }

    res.json(alerts);

  } catch (error) {
    console.error('Error al obtener alertas:', error);
    res.status(500).json({
      message: 'Error al obtener alertas',
      error: error.message
    });
  }
};

module.exports = exports;