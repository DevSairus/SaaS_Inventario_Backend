// middleware/validate.js
const { validationResult } = require('express-validator');

// Nombres de campo en español para mensajes de usuario
const FIELD_LABELS = {
  email:        'Correo electrónico',
  password:     'Contraseña',
  first_name:   'Nombre',
  last_name:    'Apellido',
  phone:        'Teléfono',
  role:         'Rol',
  tenant_id:    'Empresa',
  stratum:      'Estrato',
  identification_number: 'Número de identificación',
};

// Requisitos de contraseña que se envían al frontend para mostrarlos en el formulario
const PASSWORD_REQUIREMENTS = [
  { rule: 'minLength', label: 'Mínimo 8 caracteres' },
  { rule: 'uppercase', label: 'Al menos una letra mayúscula (A-Z)' },
  { rule: 'number',    label: 'Al menos un número (0-9)' },
];

/**
 * Middleware para validar los resultados de express-validator.
 *
 * Respuesta 422 en caso de error:
 * {
 *   success: false,
 *   code: 'VALIDATION_ERROR',
 *   message: 'Mensaje resumen para modal',
 *   fieldErrors: { campo: 'primer mensaje de error' },   ← para resaltar inputs
 *   messages:    ['Mensaje 1', 'Mensaje 2', ...],        ← lista para mostrar en modal/toast
 *   passwordRequirements: [...]                          ← solo si hay error en password
 * }
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errorArray = errors.array({ onlyFirstError: true });

    // Mapa campo → primer mensaje (para resaltar el input en el frontend)
    const fieldErrors = {};
    errorArray.forEach((err) => {
      const field = err.path || err.param;
      if (!fieldErrors[field]) {
        const label = FIELD_LABELS[field] || field;
        fieldErrors[field] = `${label}: ${err.msg}`;
      }
    });

    // Lista plana de mensajes para mostrar en modal o toast
    const messages = errorArray.map((err) => {
      const field = err.path || err.param;
      const label = FIELD_LABELS[field] || field;
      return `${label}: ${err.msg}`;
    });

    // Incluir requisitos de contraseña si ese campo tiene error
    const hasPasswordError = errorArray.some(
      (err) => (err.path || err.param) === 'password'
    );

    return res.status(422).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: messages.length === 1
        ? messages[0]
        : `Se encontraron ${messages.length} errores. Por favor revisa los campos marcados.`,
      fieldErrors,
      messages,
      ...(hasPasswordError && { passwordRequirements: PASSWORD_REQUIREMENTS }),
    });
  }

  next();
};

module.exports = { validate, PASSWORD_REQUIREMENTS };
