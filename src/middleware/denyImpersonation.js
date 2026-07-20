// Bloquea el acceso a rutas de superadmin cuando la sesión actual es una
// impersonación (JWT con claim `impersonated_by`) — evita que una sesión de
// soporte pueda re-impersonar a otro tenant o tocar cualquier dato global,
// incluso si el rol impersonado tuviera por error un permiso superadmin.*
// asignado en RolePermission.
function denyImpersonation(req, res, next) {
  if (req.user?.impersonated_by) {
    return res.status(403).json({
      success: false,
      message: 'Esta acción no está disponible durante una sesión de soporte (impersonación).',
    });
  }
  next();
}

module.exports = { denyImpersonation };
