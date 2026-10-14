// Alcance de los usuarios de plataforma (role super_admin / support, sin tenant).
//
//   owner       -> super_admin con is_owner = true. Ve todo y además administra
//                  a los demás usuarios de plataforma (routes/superadmin/platformUsers).
//   sin restricción (all_tenants_access = true, el default) -> igual que antes:
//                  todas las empresas y todas las funciones globales.
//   restringido (all_tenants_access = false) -> solo las empresas asignadas en
//                  platform_user_tenants, y solo las rutas de RESTRICTED_ALLOWED
//                  (nada global: planes, migraciones, integraciones, permisos...).
//
// El alcance se lee de la BD en cada request (no del JWT), así un cambio del
// owner aplica de inmediato sin esperar a que el usuario vuelva a iniciar sesión.

const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('../models/auth/User');

const PLATFORM_ROLES = ['super_admin', 'support'];
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

async function getAllowedTenantIds(userId) {
  const rows = await sequelize.query(
    'SELECT tenant_id FROM public.platform_user_tenants WHERE user_id = :userId',
    { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
  );
  return rows.map((r) => r.tenant_id);
}

// Chequeo liviano para middlewares fuera del panel (tenant.js, permisos).
async function isRestrictedPlatformUser(userId) {
  const user = await User.findByPk(userId, { attributes: ['role', 'is_owner', 'all_tenants_access'] });
  if (!user) return true;
  const isOwner = user.role === 'super_admin' && user.is_owner === true;
  return !isOwner && user.all_tenants_access === false;
}

/**
 * Carga req.platformScope = { isOwner, restricted, tenantIds, canSeeTenant(id) }.
 * Para usuarios que no son de plataforma deja req.platformScope = null.
 */
const loadPlatformScope = async (req, res, next) => {
  try {
    if (!req.user || !PLATFORM_ROLES.includes(req.user.role)) {
      req.platformScope = null;
      return next();
    }

    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'role', 'tenant_id', 'is_owner', 'all_tenants_access', 'is_active'],
    });
    if (!user || !user.is_active || user.tenant_id || !PLATFORM_ROLES.includes(user.role)) {
      return res.status(401).json({ success: false, message: 'Usuario de plataforma no válido o inactivo' });
    }

    const isOwner = user.role === 'super_admin' && user.is_owner === true;
    const restricted = !isOwner && user.all_tenants_access === false;
    const tenantIds = restricted ? await getAllowedTenantIds(user.id) : null;
    const allowed = restricted ? new Set(tenantIds.map((id) => String(id).toLowerCase())) : null;

    req.platformScope = {
      isOwner,
      restricted,
      tenantIds,
      canSeeTenant: (tenantId) => !restricted || (!!tenantId && allowed.has(String(tenantId).toLowerCase())),
    };
    next();
  } catch (error) {
    console.error('Error cargando alcance de plataforma:', error);
    res.status(500).json({ success: false, message: 'Error al validar el alcance del usuario' });
  }
};

/**
 * where de Sequelize que limita a las empresas visibles. {} si no hay restricción.
 *   Tenant.findAll({ where: { ...otros, ...tenantScopeWhere(req) } })
 *   TenantSubscription.findAll({ where: tenantScopeWhere(req, 'tenant_id') })
 */
function tenantScopeWhere(req, field = 'id') {
  const scope = req.platformScope;
  if (!scope?.restricted) return {};
  return { [field]: { [Op.in]: scope.tenantIds } };
}

const forbidden = (res, message) => res.status(403).json({ success: false, error: message, message });

const requireOwner = (req, res, next) => {
  if (!req.platformScope?.isOwner) return forbidden(res, 'Solo el owner de la plataforma puede realizar esta acción');
  next();
};

const requireUnrestricted = (req, res, next) => {
  if (req.platformScope?.restricted) return forbidden(res, 'Tu usuario tiene acceso restringido a algunas empresas y no puede usar esta función');
  next();
};

/**
 * Política para un router: si el usuario está restringido, la ruta tiene que
 * estar en `allowed` ([método(s), RegExp]) y todo UUID capturado por la regex
 * (grupos) tiene que ser una empresa de su alcance.
 */
function restrictedRoutePolicy(allowed) {
  return (req, res, next) => {
    const scope = req.platformScope;
    if (!scope?.restricted) return next();

    for (const [methods, re] of allowed) {
      if (!methods.split('|').includes(req.method)) continue;
      const match = re.exec(req.path);
      if (!match) continue;
      const ids = match.slice(1).filter(Boolean);
      if (ids.every((id) => scope.canSeeTenant(id))) return next();
      return forbidden(res, 'No tienes acceso a esta empresa');
    }
    return forbidden(res, 'Tu usuario tiene acceso restringido a algunas empresas y no puede usar esta función');
  };
}

module.exports = {
  UUID,
  loadPlatformScope,
  tenantScopeWhere,
  requireOwner,
  requireUnrestricted,
  restrictedRoutePolicy,
  getAllowedTenantIds,
  isRestrictedPlatformUser,
};
