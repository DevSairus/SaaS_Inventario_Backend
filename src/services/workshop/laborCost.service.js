// backend/src/services/workshop/laborCost.service.js
//
// Costo real (o estimado) de la mano de obra de una Orden de Trabajo.
//
// Los técnicos cobran solo comisión variable (sin salario fijo), y el % de
// comisión se define manualmente en cada liquidación (CommissionSettlement),
// no por técnico. Por lo tanto:
//   - Si la OT YA fue incluida en una liquidación, el costo real es
//     labor_amount * commission_percentage / 100 (el % de esa liquidación
//     específica, no un promedio ni el % actual del tenant).
//   - Si la OT NO ha sido liquidada todavía, se usa como estimación el % por
//     defecto configurado en tenant.business_config.default_labor_cost_percentage.
//
// Usado por: reports.controller.js#getProfitReport, dashboard.controller.js,
// workOrders.controller.js#getReport y el reporte de rentabilidad consolidado.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');
const Tenant = require('../../models/auth/Tenant');

const DEFAULT_LABOR_COST_PCT = 40;

async function getDefaultLaborCostPercentage(tenantId) {
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['business_config'] });
  const pct = tenant?.business_config?.default_labor_cost_percentage;
  return (pct === undefined || pct === null || isNaN(pct)) ? DEFAULT_LABOR_COST_PCT : parseFloat(pct);
}

/**
 * Costo de mano de obra por OT, para un conjunto puntual de work_order_id.
 * Una sola query batch (no N+1) — usar cuando ya se tiene la lista de OT de
 * un reporte (ej. getReport de work orders).
 *
 * @returns {Promise<Map<string, {labor_revenue: number, labor_cost: number, is_real: boolean}>>}
 */
async function getLaborCostByWorkOrderIds(tenantId, workOrderIds, defaultPct = null) {
  const result = new Map();
  if (!workOrderIds || workOrderIds.length === 0) return result;

  const pct = defaultPct !== null ? defaultPct : await getDefaultLaborCostPercentage(tenantId);
  const schema = getCurrentSchema() || 'public';

  const rows = await sequelize.query(
    `
      SELECT csi.work_order_id,
        SUM(csi.labor_amount * cs.commission_percentage / 100.0)::numeric as real_cost,
        SUM(csi.labor_amount)::numeric as settled_labor_amount
      FROM "${schema}"."commission_settlement_items" csi
      INNER JOIN "${schema}"."commission_settlements" cs ON cs.id = csi.settlement_id
      WHERE cs.tenant_id = :tenantId
        AND csi.work_order_id IN (:workOrderIds)
      GROUP BY csi.work_order_id
    `,
    { replacements: { tenantId, workOrderIds }, type: QueryTypes.SELECT }
  );

  const settledMap = new Map(rows.map(r => [r.work_order_id, parseFloat(r.real_cost) || 0]));

  return { pct, settledMap };
}

/**
 * Dado el ingreso de mano de obra de una OT y el mapa de costos reales ya
 * liquidados (de getLaborCostByWorkOrderIds), resuelve el costo final a usar.
 */
function resolveLaborCost(workOrderId, laborRevenue, settledMap, pct) {
  if (settledMap.has(workOrderId)) {
    return { labor_cost: settledMap.get(workOrderId), is_real: true };
  }
  return { labor_cost: (parseFloat(laborRevenue) || 0) * pct / 100, is_real: false };
}

/**
 * Costo de mano de obra agregado para un período completo (dashboard,
 * reporte de rentabilidad). branch_id se resuelve vía warehouse_id de la OT
 * (WorkOrder no tiene branch_id propio — 1 sede = 1 bodega, mismo criterio
 * que reports.controller.js#getMovementsByMonth).
 */
async function getLaborCostForPeriod({ tenantId, branchWarehouseId = null, dateFrom, dateTo, defaultPct = null }) {
  const pct = defaultPct !== null ? defaultPct : await getDefaultLaborCostPercentage(tenantId);
  const schema = getCurrentSchema() || 'public';

  const dateFilter = dateFrom && dateTo
    ? `COALESCE(wo.delivered_at, wo.created_at) BETWEEN :dateFrom AND :dateTo`
    : `1=1`;
  const branchFilter = branchWarehouseId ? `AND wo.warehouse_id = :branchWarehouseId` : '';

  const [row] = await sequelize.query(
    `
      WITH labor_items AS (
        SELECT wo.id AS work_order_id,
          SUM(woi.quantity * woi.unit_price) AS labor_revenue
        FROM "${schema}"."work_orders" wo
        INNER JOIN "${schema}"."work_order_items" woi ON woi.work_order_id = wo.id
        WHERE wo.tenant_id = :tenantId
          AND woi.item_type IN ('servicio', 'mano_obra')
          AND wo.status = 'entregado'
          AND ${dateFilter}
          ${branchFilter}
        GROUP BY wo.id
      ),
      settled AS (
        SELECT csi.work_order_id,
          SUM(csi.labor_amount * cs.commission_percentage / 100.0) AS real_cost
        FROM "${schema}"."commission_settlement_items" csi
        INNER JOIN "${schema}"."commission_settlements" cs ON cs.id = csi.settlement_id
        WHERE cs.tenant_id = :tenantId
        GROUP BY csi.work_order_id
      )
      SELECT
        COALESCE(SUM(li.labor_revenue), 0)::numeric as labor_revenue,
        COALESCE(SUM(COALESCE(st.real_cost, li.labor_revenue * :pct / 100.0)), 0)::numeric as labor_cost,
        COALESCE(SUM(st.real_cost), 0)::numeric as labor_cost_real,
        COALESCE(SUM(CASE WHEN st.real_cost IS NULL THEN li.labor_revenue * :pct / 100.0 ELSE 0 END), 0)::numeric as labor_cost_estimated
      FROM labor_items li
      LEFT JOIN settled st ON st.work_order_id = li.work_order_id
    `,
    { replacements: { tenantId, dateFrom, dateTo, branchWarehouseId, pct }, type: QueryTypes.SELECT }
  );

  return {
    labor_revenue: parseFloat(row?.labor_revenue) || 0,
    labor_cost: parseFloat(row?.labor_cost) || 0,
    labor_cost_real: parseFloat(row?.labor_cost_real) || 0,
    labor_cost_estimated: parseFloat(row?.labor_cost_estimated) || 0,
    default_labor_cost_percentage: pct,
  };
}

module.exports = {
  DEFAULT_LABOR_COST_PCT,
  getDefaultLaborCostPercentage,
  getLaborCostByWorkOrderIds,
  resolveLaborCost,
  getLaborCostForPeriod,
};
