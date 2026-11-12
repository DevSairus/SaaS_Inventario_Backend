/**
 * Socket.io namespace para inbox WhatsApp Cloud (coexistencia).
 * Todas las salas llevan el tenant del JWT: tenant:{id}:wa, tenant:{id}:wa:user:{id},
 * tenant:{id}:wa:conv:{id}. Conocer un id de otro tenant no basta para escuchar.
 */

let waNsp = null;

const tenantRoom = (tenantId) => `tenant:${tenantId}:wa`;
const userRoom = (tenantId, userId) => `tenant:${tenantId}:wa:user:${userId}`;
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
    if (!tenantId) return;
    socket.join(tenantRoom(tenantId));
    if (userId) socket.join(userRoom(tenantId, userId));

    socket.on('wa:subscribe', ({ conversationId } = {}) => {
      if (conversationId) socket.join(convRoom(tenantId, conversationId));
    });
    socket.on('wa:unsubscribe', ({ conversationId } = {}) => {
      if (conversationId) socket.leave(convRoom(tenantId, conversationId));
    });
  });

  waNsp = nsp;
  console.log('[WS] Namespace /whatsapp registrado');
}

function emitWaTenant(tenantId, event, data) {
  if (!waNsp || !tenantId) return;
  waNsp.to(tenantRoom(tenantId)).emit(event, data);
}

/**
 * Evento de una conversación: tenant + sala de la conversación + asesor
 * asignado en UNA sola emisión (socket.io no repite a quien esté en varias).
 */
function emitWaConversationEvent(tenantId, { conversationId, userId }, event, data) {
  if (!waNsp || !tenantId) return;
  let target = waNsp.to(tenantRoom(tenantId));
  if (conversationId) target = target.to(convRoom(tenantId, conversationId));
  if (userId) target = target.to(userRoom(tenantId, userId));
  target.emit(event, data);
}

module.exports = {
  initWhatsAppNotifications,
  emitWaTenant,
  emitWaConversationEvent,
};
