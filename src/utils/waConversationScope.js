// Visibilidad de conversaciones WhatsApp (RBAC inbox).
// admin/super_admin: todas
// manager: asignadas a vendedores de sus sedes + sin asignar + propias
// seller/otros: propias + sin asignar (cola para reclamar)
const { Op } = require('sequelize');
const { UserBranch } = require('../models');

const ADMIN_ROLES = ['admin', 'super_admin'];//
// roles de administrador

async function sellersInManagerBranches(tenantId, managerUserId) {
  const managerBranches = await UserBranch.findAll({ where: { user_id: managerUserId } });
  const branchIds = managerBranches.map((b) => b.branch_id);
  if (branchIds.length === 0) return [managerUserId];

  const branchUsers = await UserBranch.findAll({ where: { branch_id: { [Op.in]: branchIds } } });
  const userIds = [...new Set(branchUsers.map((b) => b.user_id))];  
  return userIds.length ? userIds : [managerUserId];// si hay usuarios en las sucursales, devuelve los ids de los usuarios, sino devuelve el id del manager
}// fin de la función sellersInManagerBranches

async function applyWaConversationScope(req, where = {}) {
  const role = req.user?.role;
  if (ADMIN_ROLES.includes(role)) return where;

  if (role === 'manager') {
    const userIds = await sellersInManagerBranches(req.user.tenant_id, req.user.id);
    return {
      ...where,
      [Op.or]: [
        { assigned_user_id: { [Op.in]: userIds } },
        { assigned_user_id: null },
      ],
    };
  }

  return {
    ...where,
    [Op.or]: [
      { assigned_user_id: req.user.id },
      { assigned_user_id: null },
    ],
  };
}

function canManageAllAssignments(role) {
  return ['admin', 'manager', 'super_admin'].includes(role);
}

module.exports = {
  applyWaConversationScope,
  canManageAllAssignments,
  ADMIN_ROLES,
};
