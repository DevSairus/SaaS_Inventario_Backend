const Permission = require('../models/auth/Permission');
const RolePermission = require('../models/auth/RolePermission');

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

      const permission = await Permission.findOne({
        where: { name: permissionName, is_active: true }
      });

      if (!permission) {
        return res.status(403).json({
          success: false,
          message: 'Permiso no encontrado'
        });
      }

      const hasPermission = await RolePermission.findOne({
        where: {
          role,
          permission_id: permission.id
        }
      });

      if (!hasPermission) {
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
        const permission = await Permission.findOne({
          where: { name: permName, is_active: true }
        });

        if (!permission) {
          return res.status(403).json({
            success: false,
            message: `Permiso no encontrado: ${permName}`
          });
        }

        const hasPermission = await RolePermission.findOne({
          where: {
            role,
            permission_id: permission.id
          }
        });

        if (!hasPermission) {
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
        const permission = await Permission.findOne({
          where: { name: permName, is_active: true }
        });

        if (!permission) continue;

        const hasPermission = await RolePermission.findOne({
          where: {
            role,
            permission_id: permission.id
          }
        });

        if (hasPermission) {
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
