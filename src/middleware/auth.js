const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env variable is not set. Server cannot start securely.');
  process.exit(1);
}

/**
 * Middleware para verificar JWT
 * ❗ SOLO autentica (401)
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Token no proporcionado'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Token inválido o expirado'
    });
  }
};

/**
 * Middleware de roles
 * ❗ 403 = autenticado pero sin permisos
 */
// Rol que, en las rutas que aún usan listas fijas de roles, se comporta como
// otro. El Líder de inventarios hereda de bodeguero; en lo que ya pasó a
// permisos por empresa (middleware/requirePermission.js) tiene los suyos.
const ROLE_INHERITS = { inventory_lead: 'warehouse_keeper' };

const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'No autenticado'
      });
    }

    if (!allowedRoles.includes(req.user.role) && !allowedRoles.includes(ROLE_INHERITS[req.user.role])) {
      return res.status(403).json({
        success: false,
        code: 'FORBIDDEN',
        message: `Tu rol (${req.user.role}) no tiene permiso para realizar esta acción`
      });
    }

    next();
  };
};

module.exports = {
  authMiddleware,
  checkRole,
}