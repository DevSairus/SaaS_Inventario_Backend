const Permission = require('../models/auth/Permission');
const RolePermission = require('../models/auth/RolePermission');

/**
 * Middleware para verificar si el usuario tiene un permiso específico
 * @param {string} permissionName - Nombre del permiso (ej: 'invoices.create')
 */
const checkPermission = (permissionName) => {
  return async (req, res, next) => {
    try {
      // Verificar que el usuario esté autenticado
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'No autenticado',
        });
      }

      const userRole = req.user.role;

      // Super admin siempre tiene todos los permisos
      if (userRole === 'super_admin') {
        return next();
      }

      // Buscar si el rol tiene el permiso
      const permission = await Permission.findOne({
        where: { name: permissionName, is_active: true },
      });

      if (!permission) {
        console.warn(`⚠️ Permiso no encontrado: ${permissionName}`);
        return res.status(403).json({
          success: false,
          message: 'Permiso no encontrado',
        });
      }

      const rolePermission = await RolePermission.findOne({
        where: {
          role: userRole,
          permission_id: permission.id,
        },
      });

      if (!rolePermission) {
        return res.status(403).json({
          success: false,
          message: 'No tienes permisos para realizar esta acción',
          required_permission: permissionName,
        });
      }

      // Usuario tiene el permiso, continuar
      next();
    } catch (error) {
      console.error('Error verificando permiso:', error);
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos',
        error: error.message,
      });
    }
  };
};

/**
 * Helper para verificar múltiples permisos (requiere TODOS)
 * @param {string[]} permissions - Array de permisos requeridos
 */
const checkPermissions = (permissions) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'No autenticado',
        });
      }

      const userRole = req.user.role;

      // Super admin siempre pasa
      if (userRole === 'super_admin') {
        return next();
      }

      // Verificar todos los permisos
      for (const permName of permissions) {
        const permission = await Permission.findOne({
          where: { name: permName, is_active: true },
        });

        if (!permission) {
          return res.status(403).json({
            success: false,
            message: `Permiso no encontrado: ${permName}`,
          });
        }

        const rolePermission = await RolePermission.findOne({
          where: {
            role: userRole,
            permission_id: permission.id,
          },
        });

        if (!rolePermission) {
          return res.status(403).json({
            success: false,
            message: 'No tienes todos los permisos requeridos',
            required_permissions: permissions,
          });
        }
      }

      next();
    } catch (error) {
      console.error('Error verificando permisos:', error);
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos',
        error: error.message,
      });
    }
  };
};

/**
 * Helper para verificar si tiene AL MENOS UNO de los permisos
 * @param {string[]} permissions - Array de permisos (requiere al menos uno)
 */
const checkAnyPermission = (permissions) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'No autenticado',
        });
      }

      const userRole = req.user.role;

      if (userRole === 'super_admin') {
        return next();
      }

      // Verificar si tiene al menos uno
      for (const permName of permissions) {
        const permission = await Permission.findOne({
          where: { name: permName, is_active: true },
        });

        if (permission) {
          const rolePermission = await RolePermission.findOne({
            where: {
              role: userRole,
              permission_id: permission.id,
            },
          });

          if (rolePermission) {
            return next(); // Tiene al menos uno, continuar
          }
        }
      }

      // No tiene ninguno
      return res.status(403).json({
        success: false,
        message: 'No tienes los permisos necesarios',
        required_any: permissions,
      });
    } catch (error) {
      console.error('Error verificando permisos:', error);
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos',
        error: error.message,
      });
    }
  };
};

module.exports = {
  checkPermission,
  checkPermissions,
  checkAnyPermission,
};