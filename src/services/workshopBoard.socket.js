/**
 * Socket.io namespace para la pantalla de taller (mapa de ocupación).
 *
 * Dos formas de conectarse:
 *   - auth.displayToken: el TV de la sede (/pantalla-taller/:token), sin
 *     login. Entra solo a la sala de SU sede.
 *   - auth.token (JWT): la vista interna /workshop/board. Elige la sede con
 *     'board:subscribe' { branchId }; la sala lleva el tenant del JWT, así que
 *     conocer el id de una sede de otro tenant no basta para escuchar.
 *
 * Solo se emite 'board:changed' { kind, work_order_id, order_number, status }
 * y el cliente vuelve a pedir el tablero: así nunca viajan por el socket
 * datos que el endpoint no mostraría.
 */

let boardNsp = null;

const boardRoom = (tenantId, branchId) => `tenant:${tenantId}:board:${branchId}`;

function initWorkshopBoardNotifications(io) {
  const nsp = io.of('/workshop-board');

  nsp.use(async (socket, next) => {
    const { token, displayToken } = socket.handshake.auth || {};
    try {
      if (displayToken) {
        const { resolveDisplayToken } = require('./workshop/workshopBoard.service');
        const resolved = await resolveDisplayToken(displayToken);
        if (!resolved) return next(new Error('Enlace de pantalla inválido'));
        socket.data.display = resolved;
        return next();
      }
      if (!token) return next(new Error('Token requerido'));
      const jwt = require('jsonwebtoken');
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      return next();
    } catch {
      return next(new Error('Token inválido'));
    }
  });

  nsp.on('connection', (socket) => {
    const display = socket.data.display;
    if (display) {
      socket.join(boardRoom(display.tenantId, display.branchId));
      return;
    }
    const tenantId = socket.user?.tenant_id;
    if (!tenantId) return;
    let current = null;
    socket.on('board:subscribe', ({ branchId } = {}) => {
      if (current) socket.leave(current);
      current = branchId ? boardRoom(tenantId, branchId) : null;
      if (current) socket.join(current);
    });
  });

  boardNsp = nsp;
  console.log('[WS] Namespace /workshop-board registrado');
}

function emitBoardEvent(tenantId, branchId, data) {
  if (!boardNsp || !tenantId || !branchId) return;
  boardNsp.to(boardRoom(tenantId, branchId)).emit('board:changed', data);
}

// Al revocar o regenerar el enlace: los TV conectados con el token viejo se
// desconectan (los de la vista interna, con JWT, siguen).
async function disconnectDisplays(tenantId, branchId) {
  if (!boardNsp) return;
  boardNsp.to(boardRoom(tenantId, branchId)).emit('board:revoked', {});
  try {
    const sockets = await boardNsp.in(boardRoom(tenantId, branchId)).fetchSockets();
    sockets.filter((s) => s.data?.display).forEach((s) => s.disconnect(true));
  } catch { /* con el adapter de Redis fetchSockets puede fallar; el evento ya avisó */ }
}

module.exports = { initWorkshopBoardNotifications, emitBoardEvent, disconnectDisplays };
