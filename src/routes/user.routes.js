const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authLimiter } = require('../middleware/rateLimiter');
const { checkRole } = require('../middleware/auth');
const { checkLimits } = require('../middleware/checkLimits');
const { validate } = require('../middleware/validate');
const { body } = require('express-validator');

// Requisitos de contraseña — el frontend los muestra en el formulario de creación
router.get('/password-requirements', (req, res) => {
  const { PASSWORD_REQUIREMENTS } = require('../middleware/validate');
  res.json({
    success: true,
    data: {
      requirements: PASSWORD_REQUIREMENTS,
      hint: 'La contraseña debe cumplir todos los requisitos listados.',
    },
  });
});

// Obtener perfil del usuario actual
router.get('/profile', userController.getProfile);

// Actualizar perfil del usuario actual
router.put('/profile', userController.updateProfile);

// Cambiar contraseña
router.put('/change-password', authLimiter, userController.changePassword);

// Obtener todos los usuarios (admin, manager, seller, super_admin)
router.get('/', checkRole('admin', 'manager', 'seller', 'super_admin'), userController.getAllUsers);

// Obtener usuario por ID (admin, manager, seller, super_admin)
router.get('/:id', checkRole('admin', 'manager', 'seller', 'super_admin'), userController.getUserById);

// Crear nuevo usuario (admin, super_admin) - CON VERIFICACIÓN DE LÍMITES
router.post(
  '/',
  checkRole('admin', 'super_admin'),
  checkLimits('users'),
  [
    body('email')
      .isEmail().withMessage('Ingresa un correo electrónico válido')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 8 }).withMessage('Mínimo 8 caracteres')
      .matches(/[A-Z]/).withMessage('Debe contener al menos una letra mayúscula (A-Z)')
      .matches(/[0-9]/).withMessage('Debe contener al menos un número (0-9)'),
    body('first_name')
      .trim().notEmpty().withMessage('El nombre es requerido'),
    body('last_name')
      .trim().notEmpty().withMessage('El apellido es requerido'),
    body('role')
      .isIn(['admin', 'manager', 'seller', 'warehouse_keeper', 'user', 'viewer', 'technician'])
      .withMessage('Selecciona un rol válido'),
    body('phone')
      .optional({ checkFalsy: true })
      .isMobilePhone().withMessage('Número de teléfono inválido'),
  ],
  validate,
  userController.createUser
);

// Crear cliente (admin y operario) - CON VERIFICACIÓN DE LÍMITES
router.post(
  '/clients',
  checkRole('admin', 'manager'),
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

// Actualizar usuario (admin, super_admin)
router.put('/:id', checkRole('admin', 'super_admin'), userController.updateUser);

// Activar/desactivar usuario (admin, super_admin)
router.patch(
  '/:id/toggle-status',
  checkRole('admin', 'super_admin'),
  userController.toggleUserStatus
);

// Actualizar configuración de auto-generación de facturas
router.put(
  '/:id/auto-invoice-config',
  checkRole('admin', 'manager'),
  userController.updateAutoInvoiceConfig
);

// Eliminar usuario (admin, super_admin)
router.delete('/:id', checkRole('admin', 'super_admin'), userController.deleteUser);

// Obtener estado de límites del tenant
router.get('/limits/status', userController.getLimitsStatus);

module.exports = router;