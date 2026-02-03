const { body } = require('express-validator');

const registerValidator = [
  body('email').isEmail().withMessage('Email inválido').normalizeEmail(),
  body('password')
    .isLength({ min: 6 })
    .withMessage('La contraseña debe tener al menos 6 caracteres'),
  body('first_name')
    .trim()
    .notEmpty()
    .withMessage('El nombre es requerido')
    .isLength({ max: 100 })
    .withMessage('El nombre es muy largo'),
  body('last_name')
    .trim()
    .notEmpty()
    .withMessage('El apellido es requerido')
    .isLength({ max: 100 })
    .withMessage('El apellido es muy largo'),
  body('role')
    .optional()
    .isIn(['admin', 'operario', 'cliente'])
    .withMessage('Rol inválido'),
  body('phone')
    .optional()
    .isMobilePhone()
    .withMessage('Número de teléfono inválido'),
  body('stratum')
    .optional()
    .isInt({ min: 1, max: 6 })
    .withMessage('Estrato debe estar entre 1 y 6'),
];

const loginValidator = [
  body('email').isEmail().withMessage('Email inválido').normalizeEmail(),
  body('password').notEmpty().withMessage('La contraseña es requerida'),
];

module.exports = {
  registerValidator,
  loginValidator,
};
