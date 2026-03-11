// backend/src/controllers/whatsapp.controller.js
//
// Con la nueva arquitectura wa.me + CallMeBot ya no hay sesión que gestionar.
// El endpoint /status siempre retorna CONNECTED.
// /connect y /disconnect se mantienen por compatibilidad con el frontend.

const logger = require('../config/logger');

/** GET /api/whatsapp/status — siempre CONNECTED */
const getStatus = (req, res) => {
  res.json({ success: true, status: 'CONNECTED', qr: null });
};

/** POST /api/whatsapp/connect — no-op, responde inmediatamente */
const connect = async (req, res) => {
  res.json({ success: true, status: 'CONNECTED', message: 'Modo wa.me activo — no requiere conexión.' });
};

/** POST /api/whatsapp/disconnect — no-op */
const disconnect = async (req, res) => {
  res.json({ success: true, message: 'Modo wa.me — no hay sesión que cerrar.' });
};

module.exports = { getStatus, connect, disconnect };