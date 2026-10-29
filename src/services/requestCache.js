// backend/src/services/requestCache.js
//
// Caché en memoria de lo que el middleware consulta en CADA request
// autenticado: el tenant (tenantMiddleware), la sede activa (branchMiddleware)
// y el mapa rol -> permisos (checkPermission). Sin esto, cada request hacía
// 3-5 viajes a Neon antes de llegar al controller, para datos que casi
// nunca cambian.
//
// Invalidación: hooks de Sequelize sobre los modelos limpian la caché en
// cuanto algo se escribe desde ESTE proceso. Lo que se escribe por fuera
// (scripts como cutoverTenant.js, SQL manual, otra réplica) se ve como
// mucho al vencer el TTL -- por eso los TTL son cortos.
//
// Se guardan copias planas y cada request recibe su propia instancia
// (Model.build), así un controller que modifique req.tenant no contamina a
// los demás requests.

const Tenant = require('../models/auth/Tenant');
const Permission = require('../models/auth/Permission');
const RolePermission = require('../models/auth/RolePermission');

const TENANT_TTL_MS = 30 * 1000;
const BRANCH_TTL_MS = 30 * 1000;
const PERMISSIONS_TTL_MS = 60 * 1000;

const tenantCache = new Map(); // tenantId -> { plain, expiresAt }
const branchCache = new Map(); // `${tenantId}:...` -> { value, expiresAt }
let permissionsCache = null; // { names: Set, byRole: Map<role, Set>, expiresAt }

function onWrite(model, fn) {
  for (const hook of ['afterCreate', 'afterUpdate', 'afterSave', 'afterDestroy', 'afterUpsert',
    'afterBulkCreate', 'afterBulkUpdate', 'afterBulkDestroy']) {
    model.addHook(hook, fn);
  }
}

// ── Tenant ───────────────────────────────────────────────────────────────────

async function getTenant(tenantId) {
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return Tenant.build(structuredClone(cached.plain), { isNewRecord: false, raw: true });
  }
  const tenant = await Tenant.findByPk(tenantId);
  if (tenant) {
    tenantCache.set(tenantId, { plain: structuredClone(tenant.get({ plain: true })), expiresAt: Date.now() + TENANT_TTL_MS });
  }
  return tenant;
}

function invalidateTenant(tenantId) {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

onWrite(Tenant, (instanceOrOptions) => invalidateTenant(instanceOrOptions?.id));

// ── Sede ─────────────────────────────────────────────────────────────────────
// Branch/UserBranch se cargan perezosamente: ../models requiere este archivo
// indirectamente (middleware -> models), y engancharlos al importar crearía
// un ciclo.

let branchHooksRegistered = false;
function branchModels() {
  const { Branch, UserBranch } = require('../models');
  if (!branchHooksRegistered) {
    onWrite(Branch, () => branchCache.clear());
    onWrite(UserBranch, () => branchCache.clear());
    branchHooksRegistered = true;
  }
  return { Branch, UserBranch };
}

async function cachedBranchLookup(key, load) {
  const cached = branchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.value);
  const value = await load();
  // Sin cachear "no encontrado": son casos de error/configuración que deben
  // verse corregidos de inmediato.
  if (value && (!Array.isArray(value) || value.length > 0)) {
    branchCache.set(key, { value: structuredClone(value), expiresAt: Date.now() + BRANCH_TTL_MS });
  }
  return value;
}

/** Sede activa para un admin: la pedida (si es del tenant y está activa) o la principal. */
async function getAdminBranch(tenantId, requestedBranchId) {
  const { Branch } = branchModels();
  const plain = await cachedBranchLookup(`${tenantId}:admin:${requestedBranchId || ''}`, async () => {
    const branch = requestedBranchId
      ? await Branch.findOne({ where: { id: requestedBranchId, tenant_id: tenantId, is_active: true } })
      : await Branch.findOne({
        where: { tenant_id: tenantId, is_active: true },
        order: [['is_main', 'DESC'], ['created_at', 'ASC']],
      });
    return branch ? branch.get({ plain: true }) : null;
  });
  return plain ? Branch.build(plain, { isNewRecord: false, raw: true }) : null;
}

/** Sedes activas asignadas a un usuario: [{ branch_id, is_default, branch }]. */
async function getUserBranches(tenantId, userId) {
  const { Branch, UserBranch } = branchModels();
  const rows = await cachedBranchLookup(`${tenantId}:user:${userId}`, async () => {
    const userBranches = await UserBranch.findAll({
      where: { user_id: userId },
      include: [{ model: Branch, as: 'branch', where: { is_active: true } }],
    });
    return userBranches.map((ub) => ({
      branch_id: ub.branch_id,
      is_default: ub.is_default,
      branch: ub.branch.get({ plain: true }),
    }));
  });
  return rows.map((r) => ({ ...r, branch: Branch.build(r.branch, { isNewRecord: false, raw: true }) }));
}

// ── Permisos ─────────────────────────────────────────────────────────────────

async function loadPermissions() {
  if (permissionsCache && permissionsCache.expiresAt > Date.now()) return permissionsCache;
  const [permissions, rolePermissions] = await Promise.all([
    Permission.findAll({ attributes: ['id', 'name'], raw: true }),
    RolePermission.findAll({ attributes: ['role', 'permission_id'], raw: true }),
  ]);
  const nameById = new Map(permissions.map((p) => [p.id, p.name]));
  const byRole = new Map();
  for (const rp of rolePermissions) {
    const name = nameById.get(rp.permission_id);
    if (!name) continue;
    if (!byRole.has(rp.role)) byRole.set(rp.role, new Set());
    byRole.get(rp.role).add(name);
  }
  permissionsCache = { names: new Set(nameById.values()), byRole, expiresAt: Date.now() + PERMISSIONS_TTL_MS };
  return permissionsCache;
}

/** @returns {Promise<'ok'|'missing'|'denied'>} 'missing' = el permiso no existe. */
async function checkRolePermission(role, permissionName) {
  const { names, byRole } = await loadPermissions();
  if (!names.has(permissionName)) return 'missing';
  return byRole.get(role)?.has(permissionName) ? 'ok' : 'denied';
}

onWrite(Permission, () => { permissionsCache = null; });
onWrite(RolePermission, () => { permissionsCache = null; });

module.exports = {
  getTenant,
  invalidateTenant,
  getAdminBranch,
  getUserBranches,
  checkRolePermission,
};
