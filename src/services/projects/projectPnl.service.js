// backend/src/services/projects/projectPnl.service.js
//
// Estado de resultados de un proyecto (caso de demo 2 de SOLIER), calculado
// desde los documentos operativos. Contabilidad usa las mismas reglas
// (services/accounting/projectAccounting.service.js), así que cuadran salvo
// el cargo interno por uso de herramientas, que no genera asiento.
//
//   Ingresos   ventas confirmadas del proyecto (facturas y remisiones, sin
//              IVA; sin la factura consolidada de remisiones, que es solo el
//              documento fiscal), menos notas crédito y más notas débito.
//   Materiales una sola regla para no contar dos veces: costo = lo que entra
//              a la bodega del proyecto (traslados recibidos, compras
//              recibidas allí) menos lo que sale de ella de vuelta
//              (traslados de reintegro, devoluciones a proveedor). Lo que se
//              instala, consume o vende desde la obra ya está contado.
//              Más el costo de lo vendido al proyecto desde otra bodega
//              (menos sus devoluciones a inventario).
//   Servicios  gastos con el proyecto (base + INC; el IVA descontable no es
//   y otros    costo), separados por categoría.
//   Mano de    reparto del costo de nómina por horas registradas en el proyecto
//   obra       (services/projects/projectLabor.service.js), por fecha de fin
//              del periodo de nómina.
//
// Opcional from/to (YYYY-MM-DD) filtra por fecha de cada documento.

const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');
const { ProjectBudgetLine } = require('../../models');

const table = (name) => `"${getCurrentSchema() || 'public'}"."${name}"`;
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Razones del kárdex que mueven el costo de materiales del proyecto.
const MATERIAL_IN_REASONS = ['transfer_receive', 'purchase_receipt', 'transfer_cancel', 'supplier_return_reversal'];
const MATERIAL_OUT_REASONS = ['transfer_send', 'supplier_return'];

// Categorías de gasto que cuentan como servicios/subcontratos; el resto, otros costos.
const SERVICE_EXPENSE_CATEGORIES = ['honorarios', 'mantenimiento', 'comisiones_tecnicos', 'transporte'];

const EXPENSE_CATEGORY_LABELS = {
  arriendo: 'Arriendo y alquileres', servicios_publicos: 'Servicios públicos', nomina: 'Nómina',
  mantenimiento: 'Mantenimiento', transporte: 'Transporte', impuestos: 'Impuestos', marketing: 'Marketing',
  insumos_oficina: 'Insumos', seguros: 'Seguros', honorarios: 'Honorarios y subcontratos',
  comisiones_tecnicos: 'Comisiones de técnicos', otro: 'Otros',
};

const BUDGET_CATEGORY_LABELS = {
  materials: 'Materiales', labor: 'Mano de obra', services: 'Servicios y subcontratos', other: 'Otros costos',
};

function dateFilter(column, { from, to }, replacements) {
  let sql = '';
  if (from) { sql += ` AND ${column} >= :from`; replacements.from = from; }
  if (to) { sql += ` AND ${column} < (CAST(:to AS date) + 1)`; replacements.to = to; }
  return sql;
}

async function revenueOf(tenantId, projectId, range) {
  const replacements = { tenantId, projectId };
  const dates = dateFilter('s.sale_date', range, replacements);
  const rows = await sequelize.query(`
    SELECT s.document_type,
           COUNT(*) AS docs,
           SUM(COALESCE(s.total_amount, 0) - COALESCE(s.tax_amount, 0)) AS net
      FROM ${table('sales')} s
     WHERE s.tenant_id = :tenantId AND s.status = 'completed'
       AND s.is_consolidated_invoice IS NOT TRUE
       AND (
         (s.project_id = :projectId AND s.document_type IN ('factura', 'remision', 'nota_credito', 'nota_debito'))
         OR (s.document_type IN ('nota_credito', 'nota_debito') AND s.project_id IS NULL AND s.reference_sale_id IN (
              SELECT r.id FROM ${table('sales')} r WHERE r.tenant_id = :tenantId AND r.project_id = :projectId))
       ) ${dates}
     GROUP BY s.document_type
  `, { replacements, type: sequelize.QueryTypes.SELECT });
  const by = Object.fromEntries(rows.map((r) => [r.document_type, { docs: Number(r.docs), net: num(r.net) }]));
  const invoiced = (by.factura?.net || 0) + (by.remision?.net || 0);
  const creditNotes = by.nota_credito?.net || 0;
  const debitNotes = by.nota_debito?.net || 0;
  return {
    invoiced: round2(invoiced),
    credit_notes: round2(creditNotes),
    debit_notes: round2(debitNotes),
    net: round2(invoiced - creditNotes + debitNotes),
    documents: (by.factura?.docs || 0) + (by.remision?.docs || 0),
  };
}

// Mercancía vendida al proyecto desde una bodega que no es de obra (no pasó
// por la bodega del proyecto): su costo de venta es material del proyecto,
// menos lo que el cliente devolvió a inventario. Mismo criterio que el costo
// de venta contable (autoEntries.service.js): solo productos con inventario.
async function directSalesCostOf(tenantId, projectId, range) {
  const replacements = { tenantId, projectId };
  const saleDates = dateFilter('s.sale_date', range, replacements);
  const [sold] = await sequelize.query(`
    SELECT COALESCE(SUM(si.quantity * si.unit_cost), 0) AS cost
      FROM ${table('sales')} s
      JOIN ${table('sale_items')} si ON si.sale_id = s.id AND si.item_type = 'product'
      JOIN ${table('products')} p ON p.id = si.product_id AND p.track_inventory IS TRUE
      LEFT JOIN ${table('warehouses')} w ON w.id = s.warehouse_id
     WHERE s.tenant_id = :tenantId AND s.project_id = :projectId AND s.status = 'completed'
       AND s.document_type IN ('factura', 'remision') AND s.is_consolidated_invoice IS NOT TRUE
       AND COALESCE(si.approval_status, 'aprobado') <> 'rechazado'
       AND w.project_id IS NULL ${saleDates}
  `, { replacements, type: sequelize.QueryTypes.SELECT });
  const retReplacements = { tenantId, projectId };
  const retDates = dateFilter('cr.approved_at', range, retReplacements);
  const [ret] = await sequelize.query(`
    SELECT COALESCE(SUM(ci.quantity * ci.unit_cost), 0) AS cost
      FROM ${table('customer_returns')} cr
      JOIN ${table('customer_return_items')} ci ON ci.return_id = cr.id AND ci.destination = 'inventory'
      JOIN ${table('products')} p ON p.id = ci.product_id AND p.track_inventory IS TRUE
      JOIN ${table('sales')} s ON s.id = cr.sale_id
      LEFT JOIN ${table('warehouses')} w ON w.id = s.warehouse_id
     WHERE cr.tenant_id = :tenantId AND s.project_id = :projectId AND cr.status = 'approved'
       AND w.project_id IS NULL ${retDates}
  `, { replacements: retReplacements, type: sequelize.QueryTypes.SELECT });
  return { sold: round2(num(sold?.cost)), returned: round2(num(ret?.cost)) };
}

async function materialsOf(tenantId, project, range) {
  const direct = await directSalesCostOf(tenantId, project.id, range);
  const directNet = round2(direct.sold - direct.returned);
  const empty = { delivered: 0, returned: 0, net: directNet, on_site_value: 0, in_transit: 0, sold_direct: direct.sold, sold_direct_returned: direct.returned };
  if (!project.warehouse_id) return empty;
  const replacements = { tenantId, warehouseId: project.warehouse_id, inReasons: MATERIAL_IN_REASONS, outReasons: MATERIAL_OUT_REASONS };
  const dates = dateFilter('m.movement_date', range, replacements);
  const [row] = await sequelize.query(`
    SELECT
      SUM(CASE WHEN m.direction = 'in'  AND m.movement_reason IN (:inReasons)  THEN m.total_cost ELSE 0 END) AS delivered,
      SUM(CASE WHEN m.direction = 'out' AND m.movement_reason IN (:outReasons) THEN m.total_cost ELSE 0 END) AS returned,
      SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END) AS on_site_value
      FROM ${table('inventory_movements')} m
     WHERE m.tenant_id = :tenantId AND m.warehouse_id = :warehouseId ${dates}
  `, { replacements, type: sequelize.QueryTypes.SELECT });
  const [transit] = await sequelize.query(`
    SELECT SUM(ti.quantity_sent * ti.unit_cost) AS value
      FROM ${table('transfers')} t
      JOIN ${table('transfer_items')} ti ON ti.transfer_id = t.id
     WHERE t.tenant_id = :tenantId AND t.to_warehouse_id = :warehouseId AND t.status = 'sent'
  `, { replacements, type: sequelize.QueryTypes.SELECT });
  const delivered = num(row?.delivered);
  const returned = num(row?.returned);
  return {
    delivered: round2(delivered),
    returned: round2(returned),
    net: round2(delivered - returned + directNet),
    sold_direct: direct.sold,
    sold_direct_returned: direct.returned,
    on_site_value: round2(Math.max(num(row?.on_site_value), 0)),
    in_transit: round2(num(transit?.value)),
  };
}

async function expensesOf(tenantId, projectId, range) {
  const replacements = { tenantId, projectId };
  const dates = dateFilter('e.expense_date', range, replacements);
  const rows = await sequelize.query(`
    SELECT e.category, COUNT(*) AS docs,
           SUM(COALESCE(e.subtotal, COALESCE(e.total_amount, 0) - COALESCE(e.tax_amount, 0) - COALESCE(e.inc_amount, 0))
               + COALESCE(e.inc_amount, 0)) AS cost
      FROM ${table('expenses')} e
     WHERE e.tenant_id = :tenantId AND e.project_id = :projectId ${dates}
     GROUP BY e.category
     ORDER BY cost DESC
  `, { replacements, type: sequelize.QueryTypes.SELECT });
  const byCategory = rows.map((r) => ({
    category: r.category,
    label: EXPENSE_CATEGORY_LABELS[r.category] || r.category,
    group: SERVICE_EXPENSE_CATEGORIES.includes(r.category) ? 'services' : 'other',
    documents: Number(r.docs),
    amount: round2(r.cost),
  }));
  const sumGroup = (g) => round2(byCategory.filter((c) => c.group === g).reduce((s, c) => s + c.amount, 0));
  return { services: sumGroup('services'), other: sumGroup('other'), by_category: byCategory };
}

async function laborOf(tenantId, projectId, range) {
  const replacements = { tenantId, projectId };
  const dates = dateFilter('a.period_end', range, replacements);
  const [row] = await sequelize.query(`
    SELECT COALESCE(SUM(a.amount), 0) AS amount, COALESCE(SUM(a.hours), 0) AS hours, COUNT(DISTINCT a.payroll_period_id) AS periods
      FROM ${table('project_labor_allocations')} a
     WHERE a.tenant_id = :tenantId AND a.project_id = :projectId ${dates}
  `, { replacements, type: sequelize.QueryTypes.SELECT });
  const allocated = round2(row?.amount);
  // Horas aún sin nómina repartida: costo estimado (ver estimatePendingLabor).
  const pending = await require('./projectLabor.service').estimatePendingLabor(tenantId, projectId, range);
  return {
    amount: round2(allocated + pending.amount),
    allocated,
    estimated: pending.amount,
    hours: round2(num(row?.hours) + pending.hours),
    allocated_hours: round2(row?.hours),
    pending_hours: pending.hours,
    pending_by_employee: pending.by_employee,
    periods: Number(row?.periods) || 0,
  };
}

/**
 * @param {string} tenantId
 * @param {object} project - instancia o JSON con id, warehouse_id, contract_amount
 * @param {{ from?: string, to?: string }} [range]
 */
async function getProjectPnl(tenantId, project, range = {}) {
  const [revenue, materials, expenses, budgetLines, laborRow, tools] = await Promise.all([
    revenueOf(tenantId, project.id, range),
    materialsOf(tenantId, project, range),
    expensesOf(tenantId, project.id, range),
    ProjectBudgetLine.findAll({ where: { project_id: project.id }, attributes: ['category', 'budget_amount'], raw: true }),
    laborOf(tenantId, project.id, range),
    // Cargo interno por uso de herramientas (Fase 3): suma a 'otros costos'.
    require('../tools/tools.service').projectUsageCost(tenantId, project.id, range),
  ]);

  const labor = laborRow.amount;
  const executed = { materials: materials.net, labor, services: expenses.services, other: round2(expenses.other + tools.amount) };
  const totalCosts = round2(executed.materials + executed.labor + executed.services + executed.other);
  const grossMargin = round2(revenue.net - totalCosts);

  const budgetBy = { materials: 0, labor: 0, services: 0, other: 0 };
  for (const l of budgetLines) budgetBy[l.category] = round2((budgetBy[l.category] || 0) + num(l.budget_amount));
  const budgetTotal = round2(Object.values(budgetBy).reduce((s, v) => s + v, 0));

  const budget = Object.keys(BUDGET_CATEGORY_LABELS).map((category) => {
    const b = budgetBy[category] || 0;
    const e = executed[category] || 0;
    return {
      category,
      label: BUDGET_CATEGORY_LABELS[category],
      budget: b,
      executed: round2(e),
      variance: round2(b - e),
      executed_pct: b > 0 ? Math.round((e / b) * 1000) / 10 : null,
    };
  });

  const contract = num(project.contract_amount);
  return {
    range: { from: range.from || null, to: range.to || null },
    revenue,
    costs: {
      materials,
      labor: laborRow,
      services: expenses.services,
      other: executed.other,
      expenses_by_category: expenses.by_category,
      tools,
      total: totalCosts,
    },
    gross_margin: grossMargin,
    margin_pct: revenue.net > 0 ? Math.round((grossMargin / revenue.net) * 1000) / 10 : null,
    contract_amount: contract || null,
    pending_to_invoice: contract > 0 ? round2(contract - revenue.net) : null,
    budget: {
      lines: budget,
      total: budgetTotal,
      executed: totalCosts,
      variance: round2(budgetTotal - totalCosts),
      executed_pct: budgetTotal > 0 ? Math.round((totalCosts / budgetTotal) * 1000) / 10 : null,
      // Margen esperado según contrato y presupuesto.
      expected_margin: contract > 0 ? round2(contract - budgetTotal) : null,
    },
  };
}

module.exports = { getProjectPnl, MATERIAL_IN_REASONS, MATERIAL_OUT_REASONS, BUDGET_CATEGORY_LABELS };
