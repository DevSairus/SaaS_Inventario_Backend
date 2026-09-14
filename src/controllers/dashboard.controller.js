const logger = require('../config/logger');
// backend/src/controllers/dashboard.controller.js
const { Product, Sale, SaleItem, Purchase, Customer, InventoryMovement, Warehouse, WorkOrder, WorkOrderItem, Vehicle, User, PayableAlert, CustomerAdvanceAlert, Supplier, WorkshopAppointment } = require('../models');
const { Op, fn, col, literal } = require('sequelize');

// Qué roles necesitan ver cada categoría de alerta en el dashboard general.
// Mismo criterio que ya se usa en el frontend (SALES_FINANCE_ROLES /
// INVENTORY_VALUE_ROLES de DashboardPage.jsx) y en getSuggestions() más
// abajo -- se centraliza acá para que getAlerts() también lo respete.
const ALERT_CATEGORY_ROLES = {
  inventory: ['admin', 'manager', 'seller', 'warehouse_keeper', 'accountant'],
  payables: ['admin', 'manager', 'accountant'],
  advances: ['admin', 'manager', 'accountant', 'seller'],
};
function roleCanSeeAlertCategory(role, category) {
  if (role === 'super_admin') return true;
  const allowed = ALERT_CATEGORY_ROLES[category];
  return !allowed || allowed.includes(role); // categorías sin mapear se ven por defecto
}

/**
 * Obtener KPIs principales del dashboard
 */
exports.getKPIs = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const { period = '30' } = req.query; // días
    
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - parseInt(period));

    // Ventana anterior equivalente, para calcular tendencia (p.ej. período
    // de 30d: del día -60 al día -30, comparado contra el período de 30d
    // que ya se consulta abajo). Misma duración, inmediatamente antes.
    const prevDateFrom = new Date(dateFrom);
    prevDateFrom.setDate(prevDateFrom.getDate() - parseInt(period));
    const prevDateTo = new Date(dateFrom);

    const { getLaborCostForPeriod } = require('../services/workshop/laborCost.service');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Las 9 consultas de acá abajo son independientes entre sí -- ninguna
    // usa el resultado de otra, solo se combinan al armar la respuesta. Antes
    // se esperaban una por una (9 round-trips secuenciales a la DB); ahora
    // se lanzan todas juntas y el tiempo total es el de la más lenta, no la suma.
    const [
      salesStats,     // KPI 1: Ventas del período
      profitCalc,     // Profit de productos físicos del período (ver nota abajo)
      laborProfitCalc,
      todaySales,     // KPI 2: Ventas de hoy
      lowStockCount,  // KPI 3: Productos con stock bajo (pero no sin stock)
      inventoryValue, // KPI 4: Valor total del inventario
      topProducts,    // KPI 5: Top 5 productos vendidos
      salesByDay,     // KPI 6: Ventas por día (gráfica)
      profitByDay,    // Profit por día, para combinar con salesByDay
      prevSalesStats,   // Ventas del período anterior equivalente (tendencia)
      prevProfitCalc,   // Profit de productos físicos del período anterior
      prevLaborProfitCalc,
    ] = await Promise.all([
      Sale.findOne({
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
      }),

      // Calcular profit desde los items de venta -- SOLO productos físicos
      // (product_type != 'service'). Los ítems de servicio/mano de obra nacen
      // con unit_cost = 0 (ver workOrders.controller.js), así que incluirlos
      // aquí inflaba el profit por el 100% de su precio de venta. Su ganancia
      // real se calcula aparte con laborCost.service.js (ver más abajo).
      SaleItem.findOne({
        where: {
          '$sale.tenant_id$': tenantId,
          '$sale.sale_date$': { [Op.gte]: dateFrom },
          '$sale.status$': { [Op.in]: ['completed'] },
          '$product.product_type$': { [Op.ne]: 'service' }
        },
        attributes: [
          [fn('SUM', literal('(unit_price - unit_cost) * quantity')), 'total_profit']
        ],
        include: [
          { model: Sale, as: 'sale', attributes: [], required: true },
          { model: Product, as: 'product', attributes: [], required: true }
        ],
        raw: true
      }),

      getLaborCostForPeriod({ tenantId, dateFrom, dateTo: new Date() }),

      Sale.findOne({
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
      }),

      Product.count({
        where: {
          tenant_id: tenantId,
          [Op.and]: [
            literal('current_stock <= min_stock'),
            { current_stock: { [Op.gt]: 0 } }
          ],
          is_active: true
        }
      }),

      Product.findOne({
        where: {
          tenant_id: tenantId,
          is_active: true
        },
        attributes: [
          [fn('SUM', literal('current_stock * average_cost')), 'total_value'],
          [fn('COUNT', col('id')), 'total_products']
        ],
        raw: true
      }),

      SaleItem.findAll({
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
      }),

      Sale.findAll({
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
      }),

      SaleItem.findAll({
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
      }),

      // ── Período anterior equivalente (mismas condiciones, ventana corrida) ──
      Sale.findOne({
        where: {
          tenant_id: tenantId,
          sale_date: { [Op.gte]: prevDateFrom, [Op.lt]: prevDateTo },
          status: { [Op.in]: ['completed'] }
        },
        attributes: [
          [fn('COUNT', col('id')), 'count'],
          [fn('SUM', col('total_amount')), 'revenue']
        ],
        raw: true
      }),

      SaleItem.findOne({
        where: {
          '$sale.tenant_id$': tenantId,
          '$sale.sale_date$': { [Op.gte]: prevDateFrom, [Op.lt]: prevDateTo },
          '$sale.status$': { [Op.in]: ['completed'] },
          '$product.product_type$': { [Op.ne]: 'service' }
        },
        attributes: [
          [fn('SUM', literal('(unit_price - unit_cost) * quantity')), 'total_profit']
        ],
        include: [
          { model: Sale, as: 'sale', attributes: [], required: true },
          { model: Product, as: 'product', attributes: [], required: true }
        ],
        raw: true
      }),

      getLaborCostForPeriod({ tenantId, dateFrom: prevDateFrom, dateTo: prevDateTo }),
    ]);

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

    const laborProfit = laborProfitCalc.labor_revenue - laborProfitCalc.labor_cost;
    const totalProfit = parseFloat(profitCalc?.total_profit || 0) + laborProfit;
    const totalRevenue = parseFloat(salesStats?.revenue || 0);
    const totalCount = parseInt(salesStats?.count || 0);

    // Totales del período anterior, para la tendencia (misma fórmula de arriba)
    const prevLaborProfit = prevLaborProfitCalc.labor_revenue - prevLaborProfitCalc.labor_cost;
    const prevTotalProfit = parseFloat(prevProfitCalc?.total_profit || 0) + prevLaborProfit;
    const prevTotalRevenue = parseFloat(prevSalesStats?.revenue || 0);
    const prevTotalCount = parseInt(prevSalesStats?.count || 0);

    // % de cambio vs. período anterior. Si el período anterior fue 0,
    // no hay una variación porcentual real que reportar (evita división
    // por cero y evita mostrar un falso "+infinito%" o "+100%" engañoso).
    const pctChange = (current, previous) => {
      if (!previous || previous === 0) return null;
      return parseFloat((((current - previous) / previous) * 100).toFixed(1));
    };

    res.json({
      period: parseInt(period),
      kpis: {
        sales: {
          count: totalCount,
          revenue: totalRevenue,
          profit: totalProfit,
          margin: totalRevenue > 0
            ? ((totalProfit / totalRevenue) * 100).toFixed(2)
            : 0,
          labor_cost_real: laborProfitCalc.labor_cost_real,
          labor_cost_estimated: laborProfitCalc.labor_cost_estimated,
          // Tendencia vs. el período anterior equivalente (misma duración,
          // inmediatamente antes de `dateFrom`). `null` cuando el período
          // anterior no tiene datos con qué comparar.
          trend: {
            revenue_change_pct: pctChange(totalRevenue, prevTotalRevenue),
            profit_change_pct: pctChange(totalProfit, prevTotalProfit),
            count_change_pct: pctChange(totalCount, prevTotalCount),
          },
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
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
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
    const lowStockWhere = {
      tenant_id: tenantId,
      [Op.and]: [
        literal('current_stock <= min_stock'),
        { current_stock: { [Op.gt]: 0 } }
      ],
      is_active: true
    };
    const [lowStockProducts, lowStockTotal] = await Promise.all([
      Product.findAll({
        where: lowStockWhere,
        attributes: ['id', 'name', 'sku', 'current_stock', 'min_stock'],
        limit: 10
      }),
      Product.count({ where: lowStockWhere })
    ]);

    if (lowStockTotal > 0) {
      alerts.push({
        type: 'warning',
        category: 'inventory',
        title: `${lowStockTotal} productos con stock bajo`,
        message: 'Productos que necesitan reabastecimiento',
        data: lowStockProducts.map(p => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          current_stock: parseFloat(p.current_stock),
          min_stock: parseFloat(p.min_stock)
        })),
        priority: 'high',
        action_url: '/products?filter=low_stock'
      });
    }

    // Alerta 2: Productos sin stock
    const outOfStockWhere = {
      tenant_id: tenantId,
      current_stock: 0,
      is_active: true
    };
    const [outOfStockProducts, outOfStockTotal] = await Promise.all([
      Product.findAll({
        where: outOfStockWhere,
        attributes: ['id', 'name', 'sku'],
        limit: 10
      }),
      Product.count({ where: outOfStockWhere })
    ]);

    if (outOfStockTotal > 0) {
      alerts.push({
        type: 'error',
        category: 'inventory',
        title: `${outOfStockTotal} productos sin stock`,
        message: 'Productos agotados que no se pueden vender',
        data: outOfStockProducts.map(p => ({
          id: p.id,
          name: p.name,
          sku: p.sku
        })),
        priority: 'critical',
        action_url: '/products?filter=out_of_stock'
      });
    }

    // Alerta 3: Cuentas por pagar vencidas (PayableAlert, alert_type='overdue')
    // Mismo patrón de "recheck bajo demanda" que ya usa payableAlerts.controller.js:
    // no se fuerza un barrido acá, se confía en que el middleware de eventos
    // (autoCheckPayableAlerts) ya las mantiene al día en cada compra/pago.
    const overduePayables = await PayableAlert.findAll({
      where: { tenant_id: tenantId, status: 'active', alert_type: 'overdue' },
      attributes: ['id', 'balance', 'days_to_due', 'severity'],
      include: [{
        model: Purchase, as: 'purchase', attributes: ['id', 'purchase_number'],
        include: [{ model: Supplier, as: 'supplier', attributes: ['id', 'name'] }]
      }],
      order: [['days_to_due', 'ASC']],
      limit: 10
    });

    if (overduePayables.length > 0) {
      const totalOverdueBalance = overduePayables.reduce((sum, a) => sum + parseFloat(a.balance || 0), 0);
      alerts.push({
        type: 'error',
        category: 'payables',
        title: `${overduePayables.length} facturas de proveedor vencidas`,
        message: `Suman ${totalOverdueBalance.toLocaleString('es-CO')} en saldo vencido`,
        data: overduePayables.map(a => ({
          id: a.id,
          balance: parseFloat(a.balance),
          days_overdue: Math.abs(a.days_to_due),
          supplier: a.purchase?.supplier?.name || null,
          purchase_number: a.purchase?.purchase_number || null
        })),
        priority: 'critical',
        action_url: '/accounts-payable'
      });
    }

    // Alerta 4: Cuentas por pagar próximas a vencer (alert_type='due_soon')
    const duePayables = await PayableAlert.findAll({
      where: { tenant_id: tenantId, status: 'active', alert_type: 'due_soon' },
      attributes: ['id', 'balance', 'days_to_due'],
      limit: 10
    });

    if (duePayables.length > 0) {
      const totalDueBalance = duePayables.reduce((sum, a) => sum + parseFloat(a.balance || 0), 0);
      alerts.push({
        type: 'warning',
        category: 'payables',
        title: `${duePayables.length} facturas de proveedor por vencer`,
        message: `Suman ${totalDueBalance.toLocaleString('es-CO')}, vencen pronto`,
        data: duePayables.map(a => ({
          id: a.id,
          balance: parseFloat(a.balance),
          days_to_due: a.days_to_due
        })),
        priority: 'high',
        action_url: '/accounts-payable'
      });
    }

    // Alerta 5: Anticipos de clientes sin aplicar hace mucho tiempo
    // (CustomerAdvanceAlert, ambos alert_type juntos: 'stale' y 'very_stale')
    const staleAdvances = await CustomerAdvanceAlert.findAll({
      where: { tenant_id: tenantId, status: 'active' },
      attributes: ['id', 'balance', 'days_since_received', 'alert_type', 'severity'],
      include: [{ model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name', 'business_name'] }],
      order: [['days_since_received', 'DESC']],
      limit: 10
    });

    if (staleAdvances.length > 0) {
      const totalStaleBalance = staleAdvances.reduce((sum, a) => sum + parseFloat(a.balance || 0), 0);
      const hasCritical = staleAdvances.some(a => a.severity === 'critical');
      alerts.push({
        type: hasCritical ? 'error' : 'warning',
        category: 'advances',
        title: `${staleAdvances.length} anticipos de clientes sin aplicar`,
        message: `Suman ${totalStaleBalance.toLocaleString('es-CO')} sin aplicar a una venta`,
        data: staleAdvances.map(a => ({
          id: a.id,
          balance: parseFloat(a.balance),
          days_since_received: a.days_since_received,
          customer: a.customer
            ? (a.customer.business_name || `${a.customer.first_name} ${a.customer.last_name}`)
            : null
        })),
        priority: hasCritical ? 'critical' : 'high',
        action_url: '/customer-advances'
      });
    }

    // Filtrar por rol antes de responder -- esto es lo que faltaba: las
    // tarjetas/gráficas ya se ocultaban por rol en el frontend (Fase 4),
    // pero este banner de alertas y el saludo dinámico (que lee de esta
    // misma lista) seguían mostrando TODO a TODOS los roles.
    const role = req.user.role;
    const visibleAlerts = alerts.filter(a => roleCanSeeAlertCategory(role, a.category));

    res.json(visibleAlerts);

  } catch (error) {
    logger.error('Error al obtener alertas:', error);
    res.status(500).json({
      message: 'Error al obtener alertas',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
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
    // OJO: sin calificar schema, esto siempre resolvía contra "public" --
    // para un tenant ya cortado a su propio schema, la query no encontraba
    // nada y avg_resolution_days quedaba en 0 sin ningún error visible.
    const { getCurrentSchema } = require('../config/tenantContext');
    const schema = getCurrentSchema() || 'public';
    const avgTime = await sequelize.query(`
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400), 1) as avg_days
      FROM "${schema}"."work_orders"
      WHERE tenant_id = :tenantId
        AND status = 'entregado'
        AND delivered_at IS NOT NULL
        AND created_at >= NOW() - INTERVAL '90 days'
    `, { replacements: { tenantId }, type: QueryTypes.SELECT });

    // Costo de mano de obra del mes (real si liquidado, estimado si no) --
    // usa criterio 'entregado' (no 'listo'), que es un subconjunto un poco
    // más estricto que labor_revenue_month de arriba (incluye 'listo').
    const { getLaborCostForPeriod } = require('../services/workshop/laborCost.service');
    const laborCostMonth = await getLaborCostForPeriod({ tenantId, dateFrom: startOfMonth, dateTo: now });

    // Últimas OTs actualizadas (bug fix: el frontend ya esperaba este campo
    // en `workshopStats.recentOrders`, pero nunca se consultaba ni se
    // devolvía desde aquí, así que la sección "Últimas órdenes" del
    // dashboard jamás se renderizaba).
    const recentOrdersRaw = await WorkOrder.findAll({
      where: { tenant_id: tenantId },
      attributes: ['id', 'order_number', 'status', 'total_amount', 'updated_at'],
      include: [
        { model: Vehicle, as: 'vehicle', attributes: ['plate'] },
        { model: Customer, as: 'customer', attributes: ['first_name', 'last_name', 'business_name'] },
        { model: User, as: 'technician', attributes: ['first_name'] },
      ],
      order: [['updated_at', 'DESC']],
      limit: 5,
    });

    const recentOrders = recentOrdersRaw.map(o => ({
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      total_amount: parseFloat(o.total_amount || 0),
      vehicle: o.vehicle ? { plate: o.vehicle.plate } : null,
      customer: o.customer ? {
        first_name: o.customer.first_name,
        last_name: o.customer.last_name,
        business_name: o.customer.business_name,
      } : null,
      technician: o.technician ? { first_name: o.technician.first_name } : null,
    }));

    res.json({
      success: true,
      data: {
        open_ots: openOTs,
        completed_this_month: completedThisMonth,
        labor_revenue_month: parseFloat(laborRevenue?.total || 0),
        parts_revenue_month: parseFloat(partsRevenue?.total || 0),
        total_revenue_month: parseFloat(laborRevenue?.total || 0) + parseFloat(partsRevenue?.total || 0),
        labor_cost_month: laborCostMonth.labor_cost,
        labor_profit_month: laborCostMonth.labor_revenue - laborCostMonth.labor_cost,
        labor_cost_basis: laborCostMonth.labor_cost_estimated > 0
          ? (laborCostMonth.labor_cost_real > 0 ? 'mixto' : 'estimado')
          : 'real',
        avg_resolution_days: parseFloat(avgTime[0]?.avg_days || 0),
        by_status: statusMap,
        recent_orders: recentOrders
      }
    });
  } catch (error) {
    logger.error('Error en workshop KPIs:', error);
    res.status(500).json({ success: false, message: 'Error al obtener KPIs del taller' });
  }
};

/**
 * "Para ti ahora" — sugerencias accionables del dashboard.
 *
 * Reemplaza los "Accesos Rápidos" estáticos por una lista generada a
 * partir de datos reales y filtrada por rol. Reglas de negociado:
 * - Solo se incluye cada sugerencia si aplica al rol del usuario Y hay
 *   al menos un caso real pendiente (nunca se muestra "0 OTs listas").
 * - No se recalculan las alertas (PayableAlert/CustomerAdvanceAlert) acá,
 *   se leen tal como las mantiene el middleware de eventos (autoCheck*),
 *   igual que en getAlerts().
 * - Ordenadas por prioridad: critical > high > medium.
 * - Cotizaciones "por vencer" quedaron fuera a propósito: el modelo Sale
 *   no tiene una fecha de expiración (`quote_status='vencida'` no tiene
 *   ningún job que la calcule desde una fecha), así que no hay un dato
 *   real del que partir para esa sugerencia todavía.
 */
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

exports.getSuggestions = async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;
    const role = req.user.role;
    const canSee = (roles) => role === 'super_admin' || roles.includes(role);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [
      readyOTsCount,
      overduePayablesCount,
      duePayablesCount,
      staleAdvancesCount,
      outOfStockCount,
      todaysAppointments,
    ] = await Promise.all([
      WorkOrder.count({ where: { tenant_id: tenantId, status: 'listo' } }),
      PayableAlert.count({ where: { tenant_id: tenantId, status: 'active', alert_type: 'overdue' } }),
      PayableAlert.count({ where: { tenant_id: tenantId, status: 'active', alert_type: 'due_soon' } }),
      CustomerAdvanceAlert.count({ where: { tenant_id: tenantId, status: 'active' } }),
      Product.count({ where: { tenant_id: tenantId, current_stock: 0, is_active: true } }),
      WorkshopAppointment.findAll({
        where: {
          tenant_id: tenantId,
          status: 'pendiente',
          scheduled_at: { [Op.gte]: today, [Op.lt]: tomorrow }
        },
        attributes: ['id', 'scheduled_at', 'customer_name'],
        order: [['scheduled_at', 'ASC']],
        limit: 5
      }),
    ]);

    const suggestions = [];

    if (readyOTsCount > 0 && canSee(['admin', 'manager', 'seller', 'accountant'])) {
      suggestions.push({
        id: 'ready_ots',
        title: `Facturar ${readyOTsCount} OT${readyOTsCount > 1 ? 's' : ''} lista${readyOTsCount > 1 ? 's' : ''}`,
        priority: 'critical',
        action_url: '/workshop/work-orders?status=listo'
      });
    }

    if (overduePayablesCount > 0 && canSee(['admin', 'manager', 'accountant'])) {
      suggestions.push({
        id: 'overdue_payables',
        title: `Pagar ${overduePayablesCount} factura${overduePayablesCount > 1 ? 's' : ''} vencida${overduePayablesCount > 1 ? 's' : ''}`,
        priority: 'critical',
        action_url: '/accounts-payable'
      });
    }

    if (outOfStockCount > 0 && canSee(['admin', 'manager', 'warehouse_keeper', 'seller'])) {
      suggestions.push({
        id: 'out_of_stock',
        title: `Reabastecer ${outOfStockCount} producto${outOfStockCount > 1 ? 's' : ''} agotado${outOfStockCount > 1 ? 's' : ''}`,
        priority: 'high',
        action_url: '/products?filter=out_of_stock'
      });
    }

    if (duePayablesCount > 0 && canSee(['admin', 'manager', 'accountant'])) {
      suggestions.push({
        id: 'due_payables',
        title: `${duePayablesCount} factura${duePayablesCount > 1 ? 's' : ''} de proveedor por vencer pronto`,
        priority: 'high',
        action_url: '/accounts-payable'
      });
    }

    if (staleAdvancesCount > 0 && canSee(['admin', 'manager', 'accountant', 'seller'])) {
      suggestions.push({
        id: 'stale_advances',
        title: `Aplicar ${staleAdvancesCount} anticipo${staleAdvancesCount > 1 ? 's' : ''} de cliente pendiente${staleAdvancesCount > 1 ? 's' : ''}`,
        priority: 'high',
        action_url: '/customer-advances'
      });
    }

    if (canSee(['admin', 'manager', 'seller', 'technician'])) {
      todaysAppointments.forEach((a) => {
        const time = new Date(a.scheduled_at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        suggestions.push({
          id: `appointment_${a.id}`,
          title: `Confirmar cita de las ${time} — ${a.customer_name}`,
          priority: 'medium',
          action_url: '/workshop/appointments'
        });
      });
    }

    suggestions.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));

    res.json({
      success: true,
      data: { suggestions: suggestions.slice(0, 8) }
    });
  } catch (error) {
    logger.error('Error al obtener sugerencias del dashboard:', error);
    res.status(500).json({ success: false, message: 'Error al obtener sugerencias del dashboard' });
  }
};

module.exports = exports;