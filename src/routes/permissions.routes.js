const express = require('express');
const router = express.Router();
const permissionsController = require('../controllers/permissions.controller');
const { authMiddleware } = require('../middleware/auth');
const { isRestrictedPlatformUser } = require('../middleware/platformScope');

// Middleware de rol admin
const requireAdmin = async (req, res, next) => {
  if (!['super_admin', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ success: false, message: 'Acceso denegado' });
  }
  // Superadmin con acceso restringido a algunas empresas: no toca permisos
  // globales por rol (ver middleware/platformScope.js).
  if (req.user.role === 'super_admin' && await isRestrictedPlatformUser(req.user.id)) {
    return res.status(403).json({ success: false, message: 'Acceso denegado' });
  }
  next();
};

// Todas las rutas requieren autenticación
router.use(authMiddleware);

// Obtener mis permisos (cualquier usuario autenticado)
router.get('/me', permissionsController.getMyPermissions);

// Obtener todos los permisos (solo admin)
router.get('/', requireAdmin, permissionsController.getAllPermissions);

// Obtener permisos de un rol específico (solo admin)
router.get('/roles/:role', requireAdmin, permissionsController.getRolePermissions);

// Actualizar permisos de un rol (solo admin)
router.put('/roles/:role', requireAdmin, permissionsController.updateRolePermissions);

// Agregar un permiso a un rol (solo admin)
router.post('/roles/:role', requireAdmin, permissionsController.addPermissionToRole);

// Remover un permiso de un rol (solo admin)
router.delete('/roles/:role/:permissionId', requireAdmin, permissionsController.removePermissionFromRole);

module.exports = router;