const { getEffectiveModulesForTenantId } = require('../services/moduleAccess');
const { MODULES_BY_KEY } = require('../config/modules.catalog');

/**
 * Middleware de módulos — mismo patrón que checkRole (auth.js)
 * ❗ 403 = autenticado, con tenant válido, pero su plan no incluye el módulo
 */
const requireModule = (moduleKey) => {
  return async (req, res, next) => {
    if (req.is_super_admin) {
      return next();
    }

    if (!req.tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Tenant ID no encontrado',
      });
    }

    try {
      const modules = await getEffectiveModulesForTenantId(req.tenant_id);

      if (!modules.includes(moduleKey)) {
        const label = MODULES_BY_KEY[moduleKey]?.label || moduleKey;
        return res.status(403).json({
          success: false,
          code: 'MODULE_NOT_INCLUDED',
          message: `Tu plan no incluye el módulo "${label}". Contáctanos para activarlo.`,
          module: moduleKey,
        });
      }

      next();
    } catch (error) {
      console.error('❌ [requireModule] Error:', error);
      res.status(500).json({
        success: false,
        message: 'Error al verificar módulos habilitados',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  };
};

module.exports = { requireModule };
