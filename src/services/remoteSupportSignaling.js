module.exports = function initRemoteSupportSignaling(io) {
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

    socket.on('session:join', ({ sessionId }) => {
      socket.join(`session:${sessionId}`);
      if (!socket.data.sessionIds) socket.data.sessionIds = new Set();
      socket.data.sessionIds.add(sessionId);
      socket.emit('session:joined', { sessionId });
      socket.to(`session:${sessionId}`).emit('session:peer-joined', { sessionId });
      console.log(`[WS] ${socket.user?.id} → sala ${sessionId}`);
    });

    socket.on('session:frame', ({ sessionId, frame }) => {
      socket.to(`session:${sessionId}`).emit('session:frame', { frame });
      if (!socket._frameCount) socket._frameCount = 0;
      socket._frameCount++;
      if (socket._frameCount % 20 === 1) console.log(`[WS] Frame relay: ${socket._frameCount} (sala ${sessionId})`);
    });

    // Input del agente → retransmitir al cliente
    socket.on('session:input', ({ sessionId, input }) => {
      socket.to(`session:${sessionId}`).emit('session:input', { input });
      console.log(`[WS] Input relay: ${input?.type} (sala ${sessionId})`);
    });

    socket.on('session:end', async ({ sessionId }) => {
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

  console.log('[WS] /support-remote registrado');
};
