// backend/src/utils/sessionRevocation.js
//
// Cierre forzado de todas las sesiones de un tenant. Los JWT no tienen estado,
// así que se guarda en `features.sessions_revoked_at` el momento del corte y
// tenantMiddleware / POST /auth/refresh rechazan (401 SESSION_REVOKED) todo
// token emitido antes. El frontend (api/axios.js) cierra la sesión y manda al
// login, donde el usuario entra con la configuración nueva ya cargada.
//
// Se usa al cambiar la visibilidad de remisiones (utils/remisionVisibility.js):
// lo que cada usuario ve en ventas/informes cambia, y no debe quedar ninguna
// pantalla abierta con datos o features viejos.
//
// Las sesiones de impersonación (soporte del superadmin) no se cortan.

const KEY = 'sessions_revoked_at';
const CODE = 'SESSION_REVOKED';

// features con la marca de corte puesta "ahora".
function withSessionsRevoked(features) {
  return { ...(features || {}), [KEY]: new Date().toISOString() };
}

function isSessionRevoked(tenant, user) {
  const revokedAt = tenant?.features?.[KEY];
  if (!revokedAt || !user || user.impersonated_by) return false;
  // iat va en segundos: un token emitido en el mismo segundo del corte se
  // considera posterior (es el del login inmediato).
  return (user.iat || 0) < Math.floor(Date.parse(revokedAt) / 1000);
}

function sessionRevokedResponse(res) {
  return res.status(401).json({
    success: false,
    code: CODE,
    message: 'La configuración de tu empresa cambió. Inicia sesión nuevamente.',
  });
}

module.exports = { KEY, CODE, withSessionsRevoked, isSessionRevoked, sessionRevokedResponse };
