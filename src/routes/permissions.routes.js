const express = require('express');
const router = express.Router();
const permissionsController = require('../controllers/permissions.controller');
const { authMiddleware } = require('../middleware/auth');

// Estos permisos (tablas permissions/role_permissions) son GLOBALES, de toda
// la plataforma: solo el superadmin los edita. Cada empresa administra los
// suyos en /api/role-permissions (routes/rolePermissions.routes.js).
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'super_admin') {
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