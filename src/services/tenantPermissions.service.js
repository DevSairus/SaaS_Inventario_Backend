// backend/src/services/tenantPermissions.service.js
//
// Permisos por empresa: catálogo con valores por defecto
// (config/permissions.catalog.js) + lo que cada empresa cambió
// (tenant_role_permissions). Caché corta en memoria por tenant: con varias
// réplicas, un cambio tarda como máximo CACHE_TTL_MS en verse en las demás.

const { PERMISSIONS, PERMISSIONS_BY_KEY, TENANT_ROLES, ROLE_LABELS } = require('../config/permissions.catalog');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // tenantId -> { overrides: Map('role|key' -> bool), expiresAt }

const model = () => require('../models').TenantRolePermission;
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

async function loadOverrides(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && hit.expiresAt > Date.now()) return hit.overrides;
  const rows = await model().findAll({ where: { tenant_id: tenantId }, attributes: ['role', 'permission_key', 'allowed'], raw: true });
  const overrides = new Map(rows.map((r) => [`${r.role}|${r.permission_key}`, r.allowed]));
  cache.set(tenantId, { overrides, expiresAt: Date.now() + CACHE_TTL_MS });
  return overrides;
}

const invalidate = (tenantId) => cache.delete(tenantId);

const isDefault = (role, key) => Boolean(PERMISSIONS_BY_KEY[key]?.roles.includes(role));

/**
 * ¿Puede este rol hacer esta acción en esta empresa?
 * Un permiso que no está en el catálogo es un error de programación: lanza.
 */
async function can(tenantId, role, key) {
  if (role === 'super_admin') return true;
  const perm = PERMISSIONS_BY_KEY[key];
  if (!perm) throw new Error(`Permiso desconocido: ${key}`);
  if (perm.locked && role === 'admin') return true;
  if (!tenantId) return isDefault(role, key);
  const overrides = await loadOverrides(tenantId);
  const o = overrides.get(`${role}|${key}`);
  return o === undefined ? isDefault(role, key) : o;
}

/** Permisos efectivos de un rol (para que el frontend muestre u oculte acciones). */
async function allowedKeys(tenantId, role) {
  if (role === 'super_admin') return PERMISSIONS.map((p) => p.key);
  const overrides = tenantId ? await loadOverrides(tenantId) : new Map();
  return PERMISSIONS.filter((p) => {
    if (p.locked && role === 'admin') return true;
    const o = overrides.get(`${role}|${p.key}`);
    return o === undefined ? p.roles.includes(role) : o;
  }).map((p) => p.key);
}

/** Matriz completa para la pantalla de Roles y permisos. */
async function getMatrix(tenantId) {
  const overrides = await loadOverrides(tenantId);
  return {
    roles: TENANT_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    permissions: PERMISSIONS.map((p) => ({
      key: p.key,
      group: p.group,
      label: p.label,
      hint: p.hint || null,
      locked: Boolean(p.locked),
      defaults: p.roles,
      allowed: Object.fromEntries(TENANT_ROLES.map((r) => {
        if (p.locked && r === 'admin') return [r, true];
        const o = overrides.get(`${r}|${p.key}`);
        return [r, o === undefined ? p.roles.includes(r) : o];
      })),
      customized: TENANT_ROLES.filter((r) => overrides.has(`${r}|${p.key}`)),
    })),
  };
}

/**
 * Guarda cambios: [{ role, key, allowed }]. Si el valor coincide con el
 * defecto, se borra la fila (la empresa vuelve a seguir el catálogo).
 */
async function setPermissions(tenantId, changes, userId) {
  const TRP = model();
  const { sequelize } = require('../config/database');
  if (!Array.isArray(changes) || !changes.length) throw httpError(400, 'No hay cambios');
  for (const c of changes) {
    if (!TENANT_ROLES.includes(c.role)) throw httpError(400, `Rol inválido: ${c.role}`);
    const perm = PERMISSIONS_BY_KEY[c.key];
    if (!perm) throw httpError(400, `Permiso inválido: ${c.key}`);
    if (perm.locked && c.role === 'admin' && !c.allowed) throw httpError(400, `"${perm.label}" no se le puede quitar al administrador`);
  }
  await sequelize.transaction(async (t) => {
    for (const c of changes) {
      const where = { tenant_id: tenantId, role: c.role, permission_key: c.key };
      if (Boolean(c.allowed) === isDefault(c.role, c.key)) {
        await TRP.destroy({ where, transaction: t });
      } else {
        const existing = await TRP.findOne({ where, transaction: t });
        if (existing) await existing.update({ allowed: Boolean(c.allowed), updated_by: userId }, { transaction: t });
        else await TRP.create({ ...where, allowed: Boolean(c.allowed), updated_by: userId }, { transaction: t });
      }
    }
  });
  invalidate(tenantId);
}

/** Vuelve un rol (o toda la empresa) a los permisos por defecto. */
async function resetPermissions(tenantId, role = null) {
  const where = { tenant_id: tenantId };
  if (role) where.role = role;
  await model().destroy({ where });
  invalidate(tenantId);
}

module.exports = { can, allowedKeys, getMatrix, setPermissions, resetPermissions, invalidate };
