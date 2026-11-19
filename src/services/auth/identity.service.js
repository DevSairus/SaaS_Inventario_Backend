// backend/src/services/auth/identity.service.js
// Una persona en varias empresas (contadores, auxiliares, dueños con varios
// negocios).
//
// Cada empresa en la que trabaja la persona tiene SU fila en users (rol,
// sedes, estado propios) y todas sus filas comparten identity_id y la misma
// contraseña (migración 2026111802). Por eso todo lo que ya filtra usuarios
// por tenant_id sigue igual; lo nuevo es:
//   - login: si el correo y la contraseña sirven en varias empresas, se elige
//     a cuál entrar (selection token de corta vida).
//   - cambio de empresa sin cerrar sesión: token nuevo para la fila de la
//     misma identidad en la otra empresa.
//   - vincular desde Usuarios: el admin agrega a alguien que ya existe; la
//     fila nueva copia la contraseña (nadie la conoce ni la cambia salvo la
//     persona).
//
// Seguridad: un administrador nunca puede fijar la contraseña de alguien que
// también trabaja en otras empresas (sería entrar a ellas), y el cambio de
// empresa exige además que las dos filas tengan la MISMA contraseña.
const jwt = require('jsonwebtoken');
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const User = require('../../models/auth/User');
const Tenant = require('../../models/auth/Tenant');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const SELECTION_EXPIRES_IN = '10m';

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const normEmail = (email) => String(email || '').toLowerCase().trim();
const emailWhere = (email) => sqlWhere(fn('lower', col('email')), normEmail(email));

// ── Acceso a la empresa ─────────────────────────────────────────────────────

/**
 * null si la empresa permite entrar; si no, { status, message, code } con los
 * mismos mensajes que tenía el login (suspendida, cancelada, prueba vencida...).
 */
function tenantAccessError(tenant) {
  if (!tenant) return { status: 403, message: 'Credenciales inválidas' };
  if (!tenant.is_active) {
    return { status: 403, code: 'TENANT_INACTIVE', message: 'Esta empresa fue desactivada. Contacta a soporte para más información.' };
  }
  if (tenant.subscription_status === 'suspended') {
    return { status: 402, code: 'SUBSCRIPTION_SUSPENDED', message: 'Tu suscripción está suspendida por falta de pago. Contacta a soporte para regularizar el pago y reactivar el servicio.' };
  }
  if (tenant.subscription_status === 'cancelled') {
    return { status: 403, code: 'SUBSCRIPTION_CANCELLED', message: 'Tu suscripción fue cancelada. Contacta a soporte si querés reactivarla.' };
  }
  if (tenant.subscription_status === 'trial' && tenant.trial_ends_at && new Date() > new Date(tenant.trial_ends_at)) {
    return { status: 402, code: 'TRIAL_EXPIRED', message: 'Tu período de prueba terminó. Contacta a soporte para activar tu suscripción y seguir usando el sistema.' };
  }
  return null;
}

const canLogIn = (u) => u && u.is_active && u.has_system_access && u.password_hash;

// ── Token de sesión ─────────────────────────────────────────────────────────

function signSessionToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, tenant_id: user.tenant_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/** Lo que el frontend guarda como `user` (mismo formato que antes + empresa). */
function sessionUser(user, tenant, companiesCount = 1) {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    tenant_id: user.tenant_id,
    company_name: tenant?.company_name || null,
    companies_count: companiesCount,
    // Usuarios de plataforma (ver middleware/platformScope.js). Solo para la
    // UI: el backend vuelve a leerlos de la BD en cada request.
    is_owner: user.role === 'super_admin' && user.is_owner === true,
    all_tenants_access: user.all_tenants_access !== false,
  };
}

// ── Empresas de una persona ─────────────────────────────────────────────────

/**
 * Filas de la misma identidad a las que se puede entrar con la contraseña de
 * `user`: activas, con acceso, misma contraseña y empresa habilitada. Incluye
 * la fila de `user`. Devuelve [{ user, tenant }].
 */
async function switchableAccounts(user) {
  if (!user?.identity_id || !user.tenant_id || !user.password_hash) return [];
  const rows = await User.findAll({
    where: {
      identity_id: user.identity_id,
      tenant_id: { [Op.ne]: null },
      is_active: true,
      has_system_access: true,
      password_hash: user.password_hash,
    },
  });
  if (!rows.length) return [];
  const tenants = await Tenant.findAll({
    where: { id: rows.map((r) => r.tenant_id) },
    attributes: ['id', 'company_name', 'logo_url', 'is_active', 'subscription_status', 'trial_ends_at', 'features'],
  });
  const byId = new Map(tenants.map((t) => [t.id, t]));
  return rows
    .map((u) => ({ user: u, tenant: byId.get(u.tenant_id) }))
    .filter((a) => a.tenant && !tenantAccessError(a.tenant))
    .sort((a, b) => a.tenant.company_name.localeCompare(b.tenant.company_name, 'es'));
}

const accountSummary = ({ user, tenant }, currentUserId = null) => ({
  user_id: user.id,
  tenant_id: tenant.id,
  company_name: tenant.company_name,
  logo_url: tenant.logo_url || null,
  role: user.role,
  last_login: user.last_login || null,
  is_current: currentUserId === user.id,
});

// ── Selección de empresa en el login ────────────────────────────────────────

function signSelectionToken(identityId, userIds) {
  return jwt.sign({ purpose: 'tenant_select', identity_id: identityId, user_ids: userIds }, JWT_SECRET, { expiresIn: SELECTION_EXPIRES_IN });
}

function verifySelectionToken(token) {
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.purpose !== 'tenant_select' || !Array.isArray(p.user_ids)) return null;
    return p;
  } catch {
    return null;
  }
}

// ── Correos y contraseñas ───────────────────────────────────────────────────

/**
 * Para crear una persona NUEVA con este correo (usuario de empresa, admin de
 * una empresa nueva, usuario de plataforma). Lanza 409 si el correo ya es de
 * alguien: en una empresa, para eso está "vincular".
 */
async function assertEmailAvailable(email, { transaction } = {}) {
  const existing = await User.findOne({ where: emailWhere(email), attributes: ['id', 'tenant_id'], transaction });
  if (existing) throw httpError(409, 'El email ya está registrado', 'EMAIL_EXISTS');
}

/** ¿La persona de esta fila trabaja también en otra empresa? */
async function hasOtherAccounts(user) {
  if (!user?.identity_id) return false;
  const n = await User.count({ where: { identity_id: user.identity_id, id: { [Op.ne]: user.id } } });
  return n > 0;
}

/** Cambia la contraseña en todas las filas de la persona. */
async function setIdentityPassword(user, passwordHash, { transaction } = {}) {
  const identityId = user.identity_id || user.id;
  await User.update(
    { password_hash: passwordHash },
    // validate: false -- la validación de modelo (accessRequiresCredentials)
    // se corre sobre la actualización parcial y no ve el email de la fila.
    { where: { [Op.or]: [{ identity_id: identityId }, { id: user.id }], has_system_access: true }, transaction, validate: false }
  );
}

/** Nombre y teléfono de la persona, iguales en todas sus empresas. */
async function syncIdentityProfile(user, fields) {
  if (!user?.identity_id) return;
  const data = {};
  for (const k of ['first_name', 'last_name', 'phone']) if (fields[k] !== undefined) data[k] = fields[k];
  if (!Object.keys(data).length) return;
  await User.update(data, { where: { identity_id: user.identity_id, id: { [Op.ne]: user.id } }, validate: false });
}

// ── Vincular a alguien que ya existe ────────────────────────────────────────

/**
 * Qué pasaría al agregar este correo a la empresa:
 *   { status: 'new' }            nadie lo usa: se crea normal.
 *   { status: 'member', user }   ya es usuario de esta empresa.
 *   { status: 'linkable', source } existe en otra empresa: se puede vincular.
 *   { status: 'platform' }       es un usuario de plataforma: no se vincula.
 */
async function emailStatusForTenant(email, tenantId) {
  const rows = await User.findAll({ where: emailWhere(email) });
  if (!rows.length) return { status: 'new' };
  const here = rows.find((r) => r.tenant_id === tenantId);
  if (here) return { status: 'member', user: here };
  if (rows.some((r) => !r.tenant_id)) return { status: 'platform' };
  // La fila de origen da la contraseña: la que se usó más recientemente.
  const source = rows
    .filter(canLogIn)
    .sort((a, b) => new Date(b.last_login || 0) - new Date(a.last_login || 0))[0];
  return source ? { status: 'linkable', source } : { status: 'unavailable' };
}

/**
 * Crea la fila de la persona en `tenantId` con el rol dado. Copia nombre,
 * teléfono, cédula y contraseña de su fila de origen. Lanza 409/400.
 */
async function linkExistingUser({ email, tenantId, role, transaction }) {
  const st = await emailStatusForTenant(email, tenantId);
  if (st.status === 'member') {
    throw httpError(409, st.user.is_active
      ? 'Esta persona ya es usuario de tu empresa'
      : 'Esta persona ya es usuario de tu empresa pero está inactiva: actívala desde la lista', 'ALREADY_MEMBER');
  }
  if (st.status === 'new') throw httpError(404, 'No hay ninguna cuenta de Pitbox con ese correo: crea el usuario normalmente', 'EMAIL_NOT_FOUND');
  if (st.status !== 'linkable') throw httpError(400, 'Ese correo no se puede vincular', 'NOT_LINKABLE');
  const src = st.source;
  const user = await User.create({
    tenant_id: tenantId,
    identity_id: src.identity_id || src.id,
    email: src.email,
    password_hash: src.password_hash,
    first_name: src.first_name,
    last_name: src.last_name,
    phone: src.phone,
    cedula: src.cedula || null,
    role,
    has_system_access: true,
    is_active: true,
  }, { transaction });
  return user;
}

/**
 * Sede principal por defecto para quien se vincula: sin sede, cualquier rol
 * que no sea admin cae en "Sin sede asignada" al entrar. Debe correr con el
 * schema de la empresa activo (request con tenantMiddleware, o dentro de
 * runWithTenantSchema). Nunca lanza: la vinculación no falla por esto.
 */
async function assignMainBranch(user) {
  if (!user || user.role === 'admin') return;
  try {
    const { Branch, UserBranch } = require('../../models');
    const branch = await Branch.findOne({
      where: { tenant_id: user.tenant_id, is_active: true },
      order: [['is_main', 'DESC'], ['created_at', 'ASC']],
    });
    if (branch) await UserBranch.create({ user_id: user.id, branch_id: branch.id, is_default: true });
  } catch (e) {
    console.warn('[identity] no se pudo asignar la sede principal:', e.message);
  }
}

module.exports = {
  assignMainBranch,
  tenantAccessError,
  canLogIn,
  signSessionToken,
  sessionUser,
  switchableAccounts,
  accountSummary,
  signSelectionToken,
  verifySelectionToken,
  assertEmailAvailable,
  hasOtherAccounts,
  setIdentityPassword,
  syncIdentityProfile,
  emailStatusForTenant,
  linkExistingUser,
  emailWhere,
  httpError,
};
