/**
 * Socket.io namespace para inbox WhatsApp Cloud (coexistencia).
 * Rooms: tenant:{id}:wa  |  user:{id}:wa
 */

let waNsp = null;

function initWhatsAppNotifications(io) {
  const nsp = io.of('/whatsapp');

  nsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Token requerido'));
    try {
      const jwt = require('jsonwebtoken');
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Token inválido'));
    }
  });

  nsp.on('connection', (socket) => {
    const tenantId = socket.user?.tenant_id;
    const userId = socket.user?.id;
    if (tenantId) socket.join(`tenant:${tenantId}:wa`);
    if (userId) socket.join(`user:${userId}:wa`);

    socket.on('wa:subscribe', ({ conversationId }) => {
      if (conversationId) socket.join(`wa:conv:${conversationId}`);
    });
    socket.on('wa:unsubscribe', ({ conversationId }) => {
      if (conversationId) socket.leave(`wa:conv:${conversationId}`);
    });
  });

  waNsp = nsp;
  console.log('[WS] Namespace /whatsapp registrado');
}

function emitWaTenant(tenantId, event, data) {
  if (!waNsp || !tenantId) return;
  waNsp.to(`tenant:${tenantId}:wa`).emit(event, data);
}

function emitWaUser(userId, event, data) {
  if (!waNsp || !userId) return;
  waNsp.to(`user:${userId}:wa`).emit(event, data);
}

function emitWaConversation(conversationId, event, data) {
  if (!waNsp || !conversationId) return;
  waNsp.to(`wa:conv:${conversationId}`).emit(event, data);
}

module.exports = {
  initWhatsAppNotifications,
  emitWaTenant,
  emitWaUser,
  emitWaConversation,
};
