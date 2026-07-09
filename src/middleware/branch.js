// backend/src/middleware/branch.js
const { Branch, UserBranch } = require('../models');

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
      let branch;

      if (requestedBranchId) {
        branch = await Branch.findOne({
          where: { id: requestedBranchId, tenant_id: req.tenant_id, is_active: true },
        });
        if (!branch) {
          return res.status(404).json({ success: false, message: 'Sede no encontrada o inactiva' });
        }
      } else {
        // Sin sede solicitada: usar la sede principal del tenant
        branch = await Branch.findOne({
          where: { tenant_id: req.tenant_id, is_active: true },
          order: [['is_main', 'DESC'], ['created_at', 'ASC']],
        });
        if (!branch) {
          return res.status(404).json({ success: false, message: 'Este tenant no tiene sedes configuradas' });
        }
      }

      req.branch_id = branch.id;
      req.branch = branch;
      return next();
    }

    // ── Usuario normal: debe tener la sede asignada en user_branches ───────
    const userBranches = await UserBranch.findAll({
      where: { user_id: req.user.id },
      include: [{ model: Branch, as: 'branch', where: { is_active: true } }],
    });

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
      error: error.message,
    });
  }
};

module.exports = { branchMiddleware };
