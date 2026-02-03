const jwt = require('jsonwebtoken');

const JWT_SECRET = 'inventario_jwt_secret_super_seguro';

/**
 * Middleware para verificar JWT
 */
const authMiddleware = (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'No se proporcionó token de autenticación'
      });
    }

    // El token viene en formato: "Bearer TOKEN"
    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token inválido'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Agregar datos del usuario al request
    req.user = decoded;

    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expirado'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Token inválido'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Error al verificar token',
      error: error.message
    });
  }
};

/**
 * Middleware para verificar roles
 */
const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para acceder a este recurso'
      });
    }

    next();
  };
};

module.exports = {
  authMiddleware,
  checkRole
};