/**
 * Socket.io namespace para inbox WhatsApp Cloud (coexistencia).
 * Rooms: tenant:{id}:wa  |  user:{id}:wa
 */

let waNsp = null;

const convRoom = (tenantId, conversationId) => `tenant:${tenantId}:wa:conv:${conversationId}`;

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

    // La sala lleva el tenant del JWT: conocer el id de una conversación de
    // otro tenant no basta para escucharla.
    socket.on('wa:subscribe', ({ conversationId } = {}) => {
      if (tenantId && conversationId) socket.join(convRoom(tenantId, conversationId));
    });
    socket.on('wa:unsubscribe', ({ conversationId } = {}) => {
      if (tenantId && conversationId) socket.leave(convRoom(tenantId, conversationId));
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

/**
 * Evento de una conversación: tenant + sala de la conversación + asesor
 * asignado en UNA sola emisión (socket.io no repite a quien esté en varias).
 */
function emitWaConversationEvent(tenantId, { conversationId, userId }, event, data) {
  if (!waNsp || !tenantId) return;
  let target = waNsp.to(`tenant:${tenantId}:wa`);
  if (conversationId) target = target.to(convRoom(tenantId, conversationId));
  if (userId) target = target.to(`user:${userId}:wa`);
  target.emit(event, data);
}

module.exports = {
  initWhatsAppNotifications,
  emitWaTenant,
  emitWaUser,
  emitWaConversationEvent,
};
