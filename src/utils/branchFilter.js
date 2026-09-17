// backend/src/utils/branchFilter.js

/**
 * Resuelve el branch_id a aplicar en listados/reportes sensibles (ventas,
 * compras, movimientos, cuentas por pagar, reportes financieros/operativos, etc.).
 *
 * - admin / super_admin: pueden ver cualquier sede del tenant. El `branch_id`
 *   de query se respeta como filtro OPCIONAL — si no lo envían, ven todas las
 *   sedes.
 * - Cualquier otro rol: el `branch_id` de query se IGNORA por completo. Se
 *   fuerza siempre `req.branch_id`, que `branchMiddleware` ya resolvió y
 *   validó contra las sedes asignadas al usuario en `user_branches`. Esto
 *   evita que un usuario con una sola sede asignada consulte datos de otra
 *   sede pasando `?branch_id=<otra-sede>` en la URL.
 *
 * Requiere que la ruta tenga `branchMiddleware` montado (para que
 * `req.branch_id` exista).
 *
 * OJO: no usar esto en endpoints de consulta de existencias/productos — ahí
 * la visibilidad entre sedes es intencional (para poder solicitar traslados).
 * Es solo para datos financieros/operativos por sede.
 *
 * @param {import('express').Request} req
 * @returns {string|null} branch_id a aplicar en el `where`, o null si no debe
 *   filtrarse (solo posible para admin/super_admin sin branch_id en query).
 */
function resolveBranchFilter(req) {
  const isAdmin = req.user?.role === 'admin' || req.user?.role === 'super_admin';

  if (isAdmin) {
    return req.query?.branch_id || null;
  }

  return req.branch_id || null;
}

/**
 * work_orders no tiene `branch_id` propio -- la sede se deriva de la bodega
 * (`warehouse_id` → `warehouses.branch_id`), igual que al asignarla en
 * `workOrders.controller.js#create`. Devuelve los IDs de bodega de esa sede,
 * para usar en un `where: { warehouse_id: { [Op.in]: ... } }`.
 *
 * @param {string} tenantId
 * @param {string} branchId
 * @returns {Promise<string[]>}
 */
async function getBranchWarehouseIds(tenantId, branchId) {
  const { Warehouse } = require('../models');
  const warehouses = await Warehouse.findAll({
    where: { tenant_id: tenantId, branch_id: branchId },
    attributes: ['id'],
  });
  return warehouses.map(w => w.id);
}

module.exports = { resolveBranchFilter, getBranchWarehouseIds };
