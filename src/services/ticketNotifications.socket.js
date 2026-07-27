/**
 * Socket.io namespace para notificaciones en vivo de tickets.
 */

let ticketNsp = null;

function initTicketNotifications(io) {
  const nsp = io.of('/tickets');

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
    if (socket.user?.tenant_id) {
      socket.join(`tenant:${socket.user.tenant_id}`);
    }
    socket.on('ticket:subscribe', ({ ticketId }) => socket.join(`ticket:${ticketId}`));
    socket.on('ticket:unsubscribe', ({ ticketId }) => socket.leave(`ticket:${ticketId}`));
  });

  ticketNsp = nsp;
  console.log('[WS] Namespace /tickets registrado');
}

function emitTicketEvent(tenantId, event, data) {
  if (!ticketNsp) { console.warn('[TICKET-WS] ticketNsp is null, skipping emit'); return; }
  ticketNsp.to(`tenant:${tenantId}`).emit(event, data);
  console.log(`[TICKET-WS] Emitted ${event} to tenant:${tenantId}`);
}

function emitToTicket(ticketId, event, data) {
  if (!ticketNsp) return;
  ticketNsp.to(`ticket:${ticketId}`).emit(event, data);
}

module.exports = { initTicketNotifications, emitTicketEvent, emitToTicket };
