const logger = require('../config/logger');
// backend/src/controllers/dashboard.controller.js
const { Product, Sale, SaleItem, Purchase, Customer, InventoryMovement, Warehouse, WorkOrder, WorkOrderItem } = require('../models');
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
    logger.error('Error al obtener KPIs:', error);
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
    logger.error('Error al obtener alertas:', error);
    res.status(500).json({
      message: 'Error al obtener alertas',
      error: error.message
    });
  }
};

/**
 * KPIs del módulo de taller
 */
exports.getWorkshopKPIs = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // OTs por estado
    const otsByStatus = await WorkOrder.findAll({
      where: { tenant_id: tenantId },
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true
    });

    const statusMap = {};
    otsByStatus.forEach(r => { statusMap[r.status] = parseInt(r.count); });

    // OTs abiertas (no entregadas ni canceladas)
    const openStatuses = ['recibido', 'diagnostico', 'en_proceso', 'listo'];
    const openOTs = openStatuses.reduce((sum, s) => sum + (statusMap[s] || 0), 0);

    // Ingresos de mano de obra este mes
    const laborRevenue = await WorkOrderItem.findOne({
      include: [{
        model: WorkOrder,
        as: 'work_order',
        where: {
          tenant_id: tenantId,
          status: { [Op.in]: ['listo', 'entregado'] },
          completed_at: { [Op.gte]: startOfMonth }
        },
        attributes: []
      }],
      where: { item_type: { [Op.in]: ['servicio', 'mano_obra'] } },
      attributes: [[fn('SUM', literal('quantity * unit_price')), 'total']],
      raw: true
    });

    // Ingresos de repuestos este mes
    const partsRevenue = await WorkOrderItem.findOne({
      include: [{
        model: WorkOrder,
        as: 'work_order',
        where: {
          tenant_id: tenantId,
          status: { [Op.in]: ['listo', 'entregado'] },
          completed_at: { [Op.gte]: startOfMonth }
        },
        attributes: []
      }],
      where: { item_type: 'repuesto' },
      attributes: [[fn('SUM', literal('quantity * unit_price')), 'total']],
      raw: true
    });

    // OTs completadas este mes
    const completedThisMonth = await WorkOrder.count({
      where: {
        tenant_id: tenantId,
        status: 'entregado',
        delivered_at: { [Op.gte]: startOfMonth }
      }
    });

    // Tiempo promedio de resolución (días) - últimas 30 OTs entregadas
    const { sequelize } = require('../config/database');
    const { QueryTypes } = require('sequelize');
    const avgTime = await sequelize.query(`
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400), 1) as avg_days
      FROM work_orders
      WHERE tenant_id = :tenantId
        AND status = 'entregado'
        AND delivered_at IS NOT NULL
        AND created_at >= NOW() - INTERVAL '90 days'
    `, { replacements: { tenantId }, type: QueryTypes.SELECT });

    res.json({
      success: true,
      data: {
        open_ots: openOTs,
        completed_this_month: completedThisMonth,
        labor_revenue_month: parseFloat(laborRevenue?.total || 0),
        parts_revenue_month: parseFloat(partsRevenue?.total || 0),
        total_revenue_month: parseFloat(laborRevenue?.total || 0) + parseFloat(partsRevenue?.total || 0),
        avg_resolution_days: parseFloat(avgTime[0]?.avg_days || 0),
        by_status: statusMap
      }
    });
  } catch (error) {
    logger.error('Error en workshop KPIs:', error);
    res.status(500).json({ success: false, message: 'Error al obtener KPIs del taller' });
  }
};

module.exports = exports;