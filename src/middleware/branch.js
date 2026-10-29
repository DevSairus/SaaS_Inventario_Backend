// backend/src/middleware/branch.js
const { getAdminBranch, getUserBranches } = require('../services/requestCache');

/**
 * Middleware para resolver y validar la sede (branch) activa del request.
 * Debe ir DESPUÉS de authMiddleware y tenantMiddleware.
 *
 * Resolución de la sede activa (en orden de prioridad):
 *  1. Header 'x-branch-id' enviado por el frontend (sede seleccionada por el usuario)
 *  2. Sede marcada como 'is_default' en user_branches para ese usuario
 *  3. Primera sede activa asignada al usuario
 *
 * Roles 'admin' y 'super_admin' pueden operar sobre cualquier sede del tenant,
 * incluso sin estar explícitamente asignados en user_branches.
 */
const branchMiddleware = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }

    // Super admin no opera dentro de un tenant/sede
    if (req.user.role === 'super_admin') {
      req.branch_id = null;
      req.branch = null;
      return next();
    }

    if (!req.tenant_id) {
      return res.status(403).json({ success: false, message: 'Empresa no resuelta para esta solicitud' });
    }

    const requestedBranchId = req.headers['x-branch-id'] || null;
    const isTenantAdmin = req.user.role === 'admin';

    // ── Admin: puede operar cualquier sede del tenant ──────────────────────
    if (isTenantAdmin) {
      // Cacheado unos segundos (services/requestCache.js): esto corre en cada request.
      const branch = await getAdminBranch(req.tenant_id, requestedBranchId);

      if (requestedBranchId) {
        if (!branch) {
          return res.status(404).json({ success: false, message: 'Sede no encontrada o inactiva', code: 'BRANCH_NOT_FOUND' });
        }
      } else {
        // Sin sede solicitada: usar la sede principal del tenant. Un tenant
        // sin NINGUNA sede activa no es "ruta inexistente" (404) sino un
        // tenant mal configurado -- antes devolvía 404 acá, indistinguible
        // en los logs de un endpoint que de verdad no existe (nos pasó con
        // /api/ensambladora/tecnicos: el módulo estaba activo, la ruta
        // existía, y el 404 real salía de acá, antes de llegar a
        // requireModule). 409 dice "tu request es válido pero el tenant
        // tiene una precondición sin cumplir".
        if (!branch) {
          return res.status(409).json({
            success: false,
            message: 'Este tenant no tiene sedes configuradas',
            code: 'NO_BRANCHES_CONFIGURED',
          });
        }
      }

      req.branch_id = branch.id;
      req.branch = branch;
      return next();
    }

    // ── Usuario normal: debe tener la sede asignada en user_branches ───────
    const userBranches = await getUserBranches(req.tenant_id, req.user.id);

    if (userBranches.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Tu usuario no tiene ninguna sede asignada. Contacta a un administrador.',
        code: 'NO_BRANCH_ASSIGNED',
      });
    }

    let selected;
    if (requestedBranchId) {
      selected = userBranches.find(ub => ub.branch_id === requestedBranchId);
      if (!selected) {
        return res.status(403).json({
          success: false,
          message: 'No tienes acceso a la sede solicitada',
          code: 'BRANCH_NOT_ALLOWED',
        });
      }
    } else {
      selected = userBranches.find(ub => ub.is_default) || userBranches[0];
    }

    req.branch_id = selected.branch_id;
    req.branch = selected.branch;
    next();
  } catch (error) {
    console.error('Error en branch middleware:', error);
    res.status(500).json({
      success: false,
      message: 'Error al validar la sede',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = { branchMiddleware };
