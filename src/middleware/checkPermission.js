// El mapa rol -> permisos se cachea en memoria (services/requestCache.js):
// antes eran 2 queries por permiso en cada request.
const { checkRolePermission } = require('../services/requestCache');

/**
 * Requiere UN permiso
 */
const checkPermission = (permissionName) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'No autenticado'
        });
      }

      const { role } = req.user;

      if (role === 'super_admin') {
        return next();
      }

      const result = await checkRolePermission(role, permissionName);

      if (result === 'missing') {
        return res.status(403).json({
          success: false,
          message: 'Permiso no encontrado'
        });
      }

      if (result !== 'ok') {
        return res.status(403).json({
          success: false,
          message: 'No tienes permisos para esta acción'
        });
      }

      next();
    } catch (error) {
      console.error('Error verificando permiso:', error);
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos'
      });
    }
  };
};

/**
 * Requiere TODOS los permisos
 */
const checkPermissions = (permissions = []) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'No autenticado'
        });
      }

      const { role } = req.user;

      if (role === 'super_admin') {
        return next();
      }

      for (const permName of permissions) {
        const result = await checkRolePermission(role, permName);

        if (result === 'missing') {
          return res.status(403).json({
            success: false,
            message: `Permiso no encontrado: ${permName}`
          });
        }

        if (result !== 'ok') {
          return res.status(403).json({
            success: false,
            message: 'No tienes todos los permisos requeridos'
          });
        }
      }

      next();
    } catch (error) {
      console.error('Error verificando permisos:', error);
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos'
      });
    }
  };
};

/**
 * Requiere AL MENOS UNO
 */
const checkAnyPermission = (permissions = []) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'No autenticado'
        });
      }

      const { role } = req.user;

      if (role === 'super_admin') {
        return next();
      }

      for (const permName of permissions) {
        if (await checkRolePermission(role, permName) === 'ok') {
          return next();
        }
      }

      return res.status(403).json({
        success: false,
        message: 'No tienes permisos suficientes'
      });
    } catch (error) {
      console.error('Error verificando permisos:', error);
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos'
      });
    }
  };
};

module.exports = {
  checkPermission,
  checkPermissions,
  checkAnyPermission
};
