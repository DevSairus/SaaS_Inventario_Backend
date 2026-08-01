// backend/src/utils/crmScope.js
//
// CRM — capa A de §5-bis (visibilidad, siempre activa, distinta del guard
// transaccional de checkAccountOwnership). Un seller/technician solo ve lo
// suyo; un manager ve lo de los vendedores de su(s) sede(s); admin/super_admin
// ven todo el tenant.
const { Op } = require('sequelize');
const { UserBranch, User } = require('../models');

const SCOPE_BYPASS_ROLES = ['admin', 'super_admin'];

async function sellersInManagerBranches(tenantId, managerUserId) {
  const managerBranches = await UserBranch.findAll({ where: { user_id: managerUserId } });
  const branchIds = managerBranches.map(b => b.branch_id);
  if (branchIds.length === 0) return [managerUserId]; // sin sedes asignadas: solo ve lo suyo

  const branchUsers = await UserBranch.findAll({ where: { branch_id: { [Op.in]: branchIds } } });
  const userIds = [...new Set(branchUsers.map(b => b.user_id))];
  return userIds.length ? userIds : [managerUserId];
}

// Aplica el scoping sobre un `where` de Sequelize para un modelo con columna
// `owner_user_id` (Opportunity) — o el nombre de columna que se indique
// (ej. 'assigned_to_user_id' en FollowUpTask).
async function applyOwnershipScope(req, where = {}, ownerField = 'owner_user_id') {
  const role = req.user?.role;
  if (SCOPE_BYPASS_ROLES.includes(role)) return where;

  if (role === 'manager') {
    const userIds = await sellersInManagerBranches(req.user.tenant_id, req.user.id);
    return { ...where, [ownerField]: { [Op.in]: userIds } };
  }

  // seller / technician / cualquier otro rol: solo lo propio
  return { ...where, [ownerField]: req.user.id };
}

module.exports = { applyOwnershipScope };
