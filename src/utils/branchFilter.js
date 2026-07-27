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

module.exports = { resolveBranchFilter };
