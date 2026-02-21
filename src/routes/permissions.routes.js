const express = require('express');
const router = express.Router();
const permissionsController = require('../controllers/permissions.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { checkPermission } = require('../middleware/checkPermission');

// Todas las rutas requieren autenticación
router.use(authenticate);

// Obtener mis permisos (cualquier usuario autenticado)
router.get('/me', permissionsController.getMyPermissions);

// Obtener todos los permisos (solo admin)
router.get(
  '/',
  authorize('super_admin', 'admin'),
  checkPermission('settings.permissions'),
  permissionsController.getAllPermissions
);

// Obtener permisos de un rol específico (solo admin)
router.get(
  '/roles/:role',
  authorize('super_admin', 'admin'),
  checkPermission('settings.permissions'),
  permissionsController.getRolePermissions
);

// Actualizar permisos de un rol (solo admin)
router.put(
  '/roles/:role',
  authorize('super_admin', 'admin'),
  checkPermission('settings.permissions'),
  permissionsController.updateRolePermissions
);

// Agregar un permiso a un rol (solo admin)
router.post(
  '/roles/:role',
  authorize('super_admin', 'admin'),
  checkPermission('settings.permissions'),
  permissionsController.addPermissionToRole
);

// Remover un permiso de un rol (solo admin)
router.delete(
  '/roles/:role/:permissionId',
  authorize('super_admin', 'admin'),
  checkPermission('settings.permissions'),
  permissionsController.removePermissionFromRole
);

module.exports = router;
