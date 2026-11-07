// backend/src/services/projects/projectStock.service.js
//
// Stock comprometido con proyectos. En Pitbox el stock vive en el producto
// (current_stock global, no por bodega): un despacho a la bodega de la obra
// es una salida y una entrada del mismo producto, así que current_stock no
// baja. Para que ventas/OT no cuenten como libre lo que ya es de una obra,
// el "en trámite" (services/inventory/stockInProcess.service.js) suma:
//   - reservado: project_bom_items.qty_reserved (apartado, sin despachar)
//   - en obra:   saldo neto del kárdex en la bodega del proyecto
// de proyectos vivos (no cerrados ni cancelados). Se calcula al leer, igual
// que el resto del "en trámite": nada de esto toca products.reserved_stock.

const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');

const INACTIVE_STATUSES = ['closed', 'cancelled'];

// SQL crudo: calificar con el schema del tenant (los modelos lo resuelven
// solos, ver config/registerTenantSchemaHooks.js; las literales no).
const table = (name) => `"${getCurrentSchema() || 'public'}"."${name}"`;

/**
 * Compromisos de proyectos por producto.
 * @returns {Promise<Map<string, { reserved: number, on_site: number }>>}
 */
async function getProjectCommitments(tenantId, productIds, { excludeProjectId, transaction } = {}) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  const result = new Map();
  if (!tenantId || ids.length === 0) return result;

  const replacements = { tenantId, ids, inactive: INACTIVE_STATUSES, excludeProjectId: excludeProjectId || null };
  const excludeSql = excludeProjectId ? 'AND p.id <> :excludeProjectId' : '';

  const [reservedRows, onSiteRows] = await Promise.all([
    sequelize.query(`
      SELECT b.product_id, SUM(b.qty_reserved) AS qty
        FROM ${table('project_bom_items')} b
        JOIN ${table('projects')} p ON p.id = b.project_id
       WHERE b.tenant_id = :tenantId AND b.product_id IN (:ids) AND b.qty_reserved > 0
         AND p.status NOT IN (:inactive) ${excludeSql}
       GROUP BY b.product_id
    `, { replacements, type: sequelize.QueryTypes.SELECT, transaction }),
    sequelize.query(`
      SELECT m.product_id,
             SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END) AS qty
        FROM ${table('inventory_movements')} m
        JOIN ${table('warehouses')} w ON w.id = m.warehouse_id
        JOIN ${table('projects')} p ON p.id = w.project_id
       WHERE m.tenant_id = :tenantId AND m.product_id IN (:ids)
         AND p.status NOT IN (:inactive) ${excludeSql}
       GROUP BY m.product_id
    `, { replacements, type: sequelize.QueryTypes.SELECT, transaction }),
  ]);

  const ensure = (id) => {
    if (!result.has(id)) result.set(id, { reserved: 0, on_site: 0 });
    return result.get(id);
  };
  for (const r of reservedRows) ensure(r.product_id).reserved += Number(r.qty) || 0;
  // Un saldo negativo (stock negativo permitido) no libera stock de otros.
  for (const r of onSiteRows) ensure(r.product_id).on_site += Math.max(Number(r.qty) || 0, 0);
  return result;
}

/**
 * Proyectos que comprometen un producto (ficha del producto → "Documentos en
 * trámite"). Mismo criterio que getProjectCommitments.
 */
async function getProjectCommitmentDocs(tenantId, productId) {
  const rows = await sequelize.query(`
    WITH reserved AS (
      SELECT b.project_id, SUM(b.qty_reserved) AS qty
        FROM ${table('project_bom_items')} b
       WHERE b.tenant_id = :tenantId AND b.product_id = :productId AND b.qty_reserved > 0
       GROUP BY b.project_id
    ), on_site AS (
      SELECT w.project_id, SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END) AS qty
        FROM ${table('inventory_movements')} m
        JOIN ${table('warehouses')} w ON w.id = m.warehouse_id
       WHERE m.tenant_id = :tenantId AND m.product_id = :productId AND w.project_id IS NOT NULL
       GROUP BY w.project_id
    )
    SELECT p.id, p.code, p.name, p.status, p.created_at,
           c.business_name, c.first_name, c.last_name,
           COALESCE(r.qty, 0) AS reserved, GREATEST(COALESCE(o.qty, 0), 0) AS on_site
      FROM ${table('projects')} p
      LEFT JOIN reserved r ON r.project_id = p.id
      LEFT JOIN on_site o ON o.project_id = p.id
      LEFT JOIN ${table('customers')} c ON c.id = p.customer_id
     WHERE p.tenant_id = :tenantId AND p.status NOT IN (:inactive)
       AND (COALESCE(r.qty, 0) > 0 OR COALESCE(o.qty, 0) > 0)
     ORDER BY p.code
  `, { replacements: { tenantId, productId, inactive: INACTIVE_STATUSES }, type: sequelize.QueryTypes.SELECT });

  return rows.map((r) => ({
    tipo: 'proyecto',
    id: r.id,
    numero: r.code,
    cliente: r.business_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.name,
    cantidad: (Number(r.reserved) || 0) + (Number(r.on_site) || 0),
    reservado: Number(r.reserved) || 0,
    en_obra: Number(r.on_site) || 0,
    estado: r.status,
    fecha: r.created_at,
  }));
}

/**
 * Saldo por producto de una bodega según el kárdex (cantidad y valor).
 * Solo productos con saldo distinto de cero.
 * @returns {Promise<Array<{ product_id, quantity: number, value: number }>>}
 */
async function getWarehouseBalance(tenantId, warehouseId, { transaction } = {}) {
  if (!warehouseId) return [];
  const rows = await sequelize.query(`
    SELECT m.product_id,
           SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END) AS quantity,
           SUM(CASE WHEN m.direction = 'in' THEN m.total_cost ELSE -m.total_cost END) AS value
      FROM ${table('inventory_movements')} m
     WHERE m.tenant_id = :tenantId AND m.warehouse_id = :warehouseId
     GROUP BY m.product_id
    HAVING ABS(SUM(CASE WHEN m.direction = 'in' THEN m.quantity ELSE -m.quantity END)) > 0.00005
  `, { replacements: { tenantId, warehouseId }, type: sequelize.QueryTypes.SELECT, transaction });
  return rows.map((r) => ({ product_id: r.product_id, quantity: Number(r.quantity) || 0, value: Number(r.value) || 0 }));
}

module.exports = { getProjectCommitments, getProjectCommitmentDocs, getWarehouseBalance, INACTIVE_STATUSES };
