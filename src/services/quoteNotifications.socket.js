/**
 * Socket.io namespace para notificaciones en vivo de cotizaciones de OT
 * respondidas por el cliente (aprobadas/rechazadas) — mismo patrón que
 * ticketNotifications.socket.js.
 */

let quoteNsp = null;

function initQuoteNotifications(io) {
  const nsp = io.of('/quotes');

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
  });

  quoteNsp = nsp;
  console.log('[WS] Namespace /quotes registrado');
}

function emitQuoteApproved(tenantId, data) {
  if (!quoteNsp) { console.warn('[QUOTE-WS] quoteNsp is null, skipping emit'); return; }
  quoteNsp.to(`tenant:${tenantId}`).emit('quote:approved', data);
  console.log(`[QUOTE-WS] Emitted quote:approved to tenant:${tenantId}`);
}

module.exports = { initQuoteNotifications, emitQuoteApproved };
