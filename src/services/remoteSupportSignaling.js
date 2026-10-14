let remoteNsp = null;

function initRemoteSupportSignaling(io) {
  const nsp = io.of('/support-remote');

  const closeSession = async (sessionId) => {
    const { RemoteSupportSession } = require('../models');
    const [count] = await RemoteSupportSession.update(
      { status: 'ended', ended_at: new Date() },
      { where: { id: sessionId, status: ['pending', 'active'] } },
    );
    return count > 0;
  };

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
    console.log(`[WS] Conectado: ${socket.user?.id}`);

    // Room por usuario — permite empujarle 'session:pending' apenas el
    // agente crea una sesión, sin que el cliente tenga que hacer polling
    // para enterarse (antes: checkPending cada 8s en RemoteSessionNotifier).
    if (socket.user?.id) {
      socket.join(`user:${socket.user.id}`);
    }

    // Solo el agente o el cliente de la sesión entran a la sala, y solo
    // mientras esté pendiente/activa. Antes cualquier usuario autenticado
    // (de cualquier empresa) podía unirse con el id y ver la pantalla o
    // mandar input. socket.data.sessionRoles: sessionId -> 'agent' | 'client'.
    socket.on('session:join', async ({ sessionId } = {}) => {
      try {
        const { RemoteSupportSession } = require('../models');
        const session = sessionId && await RemoteSupportSession.findByPk(sessionId, {
          attributes: ['id', 'agent_id', 'user_id', 'status'],
        });
        const userId = socket.user?.id;
        const role = session && (session.agent_id === userId ? 'agent' : session.user_id === userId ? 'client' : null);
        if (!session || !role || !['pending', 'active'].includes(session.status)) {
          socket.emit('session:error', { sessionId, message: 'No autorizado para esta sesión' });
          console.warn(`[WS] join rechazado: ${userId} → sesión ${sessionId}`);
          return;
        }
        socket.join(`session:${sessionId}`);
        if (!socket.data.sessionIds) socket.data.sessionIds = new Set();
        if (!socket.data.sessionRoles) socket.data.sessionRoles = new Map();
        socket.data.sessionIds.add(sessionId);
        socket.data.sessionRoles.set(sessionId, role);
        socket.emit('session:joined', { sessionId });
        socket.to(`session:${sessionId}`).emit('session:peer-joined', { sessionId });
        console.log(`[WS] ${userId} (${role}) → sala ${sessionId}`);
      } catch (err) {
        console.error('[WS] Error en session:join:', err.message);
        socket.emit('session:error', { sessionId, message: 'Error al unirse a la sesión' });
      }
    });

    const roleIn = (sessionId) => socket.data.sessionRoles?.get(sessionId) || null;

    // La pantalla la manda el cliente; el input, el agente.
    socket.on('session:frame', ({ sessionId, frame } = {}) => {
      if (roleIn(sessionId) !== 'client') return;
      socket.to(`session:${sessionId}`).emit('session:frame', { frame });
      if (!socket._frameCount) socket._frameCount = 0;
      socket._frameCount++;
      if (socket._frameCount % 20 === 1) console.log(`[WS] Frame relay: ${socket._frameCount} (sala ${sessionId})`);
    });

    // Input del agente → retransmitir al cliente
    socket.on('session:input', ({ sessionId, input } = {}) => {
      if (roleIn(sessionId) !== 'agent') return;
      socket.to(`session:${sessionId}`).emit('session:input', { input });
      console.log(`[WS] Input relay: ${input?.type} (sala ${sessionId})`);
    });

    socket.on('session:end', async ({ sessionId } = {}) => {
      if (!roleIn(sessionId)) return;
      try {
        const closed = await closeSession(sessionId);
        console.log(`[WS] session:end de ${socket.user?.id} → sesión ${sessionId} (bd actualizada: ${closed})`);
      } catch (err) {
        console.error('[WS] Error finalizando sesión:', err.message);
      }
      nsp.to(`session:${sessionId}`).emit('session:ended', { sessionId });
    });

    // Si el agente o el cliente cierran la pestaña / pierden conexión sin
    // terminar explícitamente la sesión, esta queda huérfana en 'pending'/
    // 'active' para siempre — hay que cerrarla y avisar al otro lado.
    socket.on('disconnect', async () => {
      console.log(`[WS] Desconectado: ${socket.user?.id} (sesiones en curso: ${socket.data.sessionIds ? [...socket.data.sessionIds] : []})`);
      if (!socket.data.sessionIds) return;
      for (const sessionId of socket.data.sessionIds) {
        try {
          const closed = await closeSession(sessionId);
          if (closed) nsp.to(`session:${sessionId}`).emit('session:ended', { sessionId });
        } catch (err) {
          console.error('[WS] Error cerrando sesión en disconnect:', err.message);
        }
      }
    });
  });

  remoteNsp = nsp;
  console.log('[WS] /support-remote registrado');
}

// Empuja la sesión pendiente al usuario destino apenas el agente la crea.
// Reemplaza el polling de 8s que tenía RemoteSessionNotifier: en vez de que
// el cliente pregunte "¿hay algo pendiente?" todo el día, el backend avisa
// una sola vez, en el momento exacto en que hay algo que avisar.
function emitSessionPending(userId, sessionData) {
  if (!remoteNsp) { console.warn('[REMOTE-WS] remoteNsp is null, skipping emit'); return; }
  remoteNsp.to(`user:${userId}`).emit('session:pending', sessionData);
  console.log(`[REMOTE-WS] Emitted session:pending to user:${userId}`);
}

module.exports = initRemoteSupportSignaling;
module.exports.initRemoteSupportSignaling = initRemoteSupportSignaling;
module.exports.emitSessionPending = emitSessionPending;
