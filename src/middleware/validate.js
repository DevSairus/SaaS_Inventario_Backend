// middleware/validate.js
const { validationResult } = require('express-validator');

/**
 * Middleware para validar los resultados de express-validator
 * y retornar errores de validación en formato consistente
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Errores de validación',
        details: errors.array().map((err) => ({
          field: err.path || err.param,
          message: err.msg,
          value: err.value,
        })),
      },
    });
  }

  next();
};

module.exports = { validate };
