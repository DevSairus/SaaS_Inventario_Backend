// backend/src/controllers/whatsapp.controller.js
const whatsappService = require('../services/whatsappService');
const logger = require('../config/logger');

/** GET /api/whatsapp/status */
const getStatus = (req, res) => {
  const { status, qr } = whatsappService.getStatus();
  res.json({ success: true, status, qr });
};

/** POST /api/whatsapp/connect — inicia sesión / genera QR */
const connect = async (req, res) => {
  try {
    const { status } = whatsappService.getStatus();
    if (status === 'CONNECTED') {
      return res.json({ success: true, status: 'CONNECTED', message: 'Ya conectado' });
    }
    if (status === 'CONNECTING' || status === 'QR_READY') {
      return res.json({ success: true, status, message: 'Conexión en progreso' });
    }

    // Iniciar en background — el QR se obtiene vía polling /status
    whatsappService.initialize().catch(err => {
      logger.error('[WhatsApp] Error background init:', err.message);
    });

    res.json({ success: true, status: 'CONNECTING', message: 'Iniciando conexión...' });
  } catch (error) {
    logger.error('[WhatsApp] Error connect:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/** POST /api/whatsapp/disconnect */
const disconnect = async (req, res) => {
  try {
    await whatsappService.disconnect();
    res.json({ success: true, message: 'Desconectado correctamente' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getStatus, connect, disconnect };