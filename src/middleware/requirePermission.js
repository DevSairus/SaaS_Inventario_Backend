// backend/src/middleware/requirePermission.js
//
// Permiso por empresa (config/permissions.catalog.js), en lugar de una lista
// fija de roles: cada empresa puede dar o quitar la acción a cualquier rol.
// Uso: router.post('/', requirePermission('inventory.transfers.write'), ...)

const { can } = require('../services/tenantPermissions.service');
const { PERMISSIONS_BY_KEY } = require('../config/permissions.catalog');

const requirePermission = (key) => {
  if (!PERMISSIONS_BY_KEY[key]) throw new Error(`requirePermission: permiso desconocido "${key}"`);
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'No autenticado' });
    try {
      if (await can(req.user.tenant_id || req.tenant_id, req.user.role, key)) return next();
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        permission: key,
        message: `No tienes permiso para: ${PERMISSIONS_BY_KEY[key].label.toLowerCase()}. Pídeselo al administrador de tu empresa.`,
      });
    } catch (error) {
      console.error('[requirePermission]', error);
      return res.status(500).json({ success: false, message: 'Error al verificar permisos' });
    }
  };
};

// Alcanza con uno de los permisos (p. ej. ver lotes de pago: quien los arma o quien los aprueba).
const requireAnyPermission = (...keys) => {
  for (const k of keys) if (!PERMISSIONS_BY_KEY[k]) throw new Error(`requireAnyPermission: permiso desconocido "${k}"`);
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'No autenticado' });
    try {
      const tenantId = req.user.tenant_id || req.tenant_id;
      for (const k of keys) if (await can(tenantId, req.user.role, k)) return next();
      return res.status(403).json({ success: false, code: 'FORBIDDEN', permission: keys[0], message: 'No tienes permiso para esta sección. Pídeselo al administrador de tu empresa.' });
    } catch (error) {
      console.error('[requireAnyPermission]', error);
      return res.status(500).json({ success: false, message: 'Error al verificar permisos' });
    }
  };
};

module.exports = { requirePermission, requireAnyPermission };
