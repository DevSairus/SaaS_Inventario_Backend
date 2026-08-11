/**
 * Socket.io namespace para notificaciones en vivo de nuevas solicitudes de
 * cita de taller creadas desde la página pública (/agendar/:slug) — mismo
 * patrón que quoteNotifications.socket.js.
 */

let appointmentNsp = null;

function initAppointmentNotifications(io) {
  const nsp = io.of('/appointments');

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

  appointmentNsp = nsp;
  console.log('[WS] Namespace /appointments registrado');
}

function emitNewAppointment(tenantId, data) {
  if (!appointmentNsp) { console.warn('[APPOINTMENT-WS] appointmentNsp is null, skipping emit'); return; }
  appointmentNsp.to(`tenant:${tenantId}`).emit('appointment:new', data);
  console.log(`[APPOINTMENT-WS] Emitted appointment:new to tenant:${tenantId}`);
}

module.exports = { initAppointmentNotifications, emitNewAppointment };
