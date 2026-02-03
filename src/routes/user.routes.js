const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authorize } = require('../middleware/auth');
const { checkLimits } = require('../middleware/checkLimits');
const { body } = require('express-validator');

// Obtener perfil del usuario actual
router.get('/profile', userController.getProfile);

// Actualizar perfil del usuario actual
router.put('/profile', userController.updateProfile);

// Cambiar contraseña
router.put('/change-password', userController.changePassword);

// Obtener todos los usuarios (admin y operario)
router.get('/', authorize('admin', 'operario'), userController.getAllUsers);

// Obtener usuario por ID (admin y operario)
router.get('/:id', authorize('admin', 'operario'), userController.getUserById);

// Crear nuevo usuario (admin) - CON VERIFICACIÓN DE LÍMITES
router.post(
  '/',
  authorize('admin'),
  checkLimits('users'),
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Contraseña mínimo 6 caracteres'),
    body('first_name').notEmpty().withMessage('Nombre es requerido'),
    body('last_name').notEmpty().withMessage('Apellido es requerido'),
    body('role')
      .isIn(['admin', 'operario', 'cliente'])
      .withMessage('Rol inválido'),
  ],
  userController.createUser
);

// Crear cliente (admin y operario) - CON VERIFICACIÓN DE LÍMITES
router.post(
  '/clients',
  authorize('admin', 'operario'),
  checkLimits('clients'),
  [
    body('email').isEmail().withMessage('Email inválido'),
    body('first_name').notEmpty().withMessage('Nombre es requerido'),
    body('last_name').notEmpty().withMessage('Apellido es requerido'),
    body('identification_number')
      .notEmpty()
      .withMessage('Número de identificación es requerido'),
    body('stratum')
      .isInt({ min: 1, max: 6 })
      .withMessage('Estrato debe ser entre 1 y 6'),
  ],
  userController.createClient
);

// Actualizar usuario (admin)
router.put('/:id', authorize('admin'), userController.updateUser);

// Activar/desactivar usuario (admin)
router.patch(
  '/:id/toggle-status',
  authorize('admin'),
  userController.toggleUserStatus
);

// Actualizar configuración de auto-generación de facturas
router.put(
  '/:id/auto-invoice-config',
  authorize('admin', 'operario'),
  userController.updateAutoInvoiceConfig
);

// Eliminar usuario (admin)
router.delete('/:id', authorize('admin'), userController.deleteUser);

// Obtener estado de límites del tenant
router.get('/limits/status', userController.getLimitsStatus);

module.exports = router;
