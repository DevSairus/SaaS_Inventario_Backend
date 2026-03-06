// backend/src/routes/cron.routes.js
//
// Endpoints para cron jobs de Vercel.
// Protegidos con CRON_SECRET en el header Authorization.
// En vercel.json se configura para que se llamen automáticamente.
//
// Variables de entorno requeridas:
//   CRON_SECRET=un-secreto-largo-y-seguro
//   TWILIO_ACCOUNT_SID (opcional, para WhatsApp)
//   TWILIO_AUTH_TOKEN  (opcional, para WhatsApp)
//   TWILIO_WHATSAPP_FROM (ej: +14155238886)
//   FRONTEND_URL=https://tu-app.vercel.app

const express = require('express');
const router  = express.Router();

// Middleware de protección
const cronAuth = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Sin secret configurado, solo permitir en desarrollo
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'CRON_SECRET no configurado' });
    }
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
};

/**
 * GET /api/cron/vehicle-reminders
 * Envía recordatorios de SOAT y Tecnomecánica.
 * Ejecutado automáticamente por Vercel Cron todos los días a las 8am COT (13:00 UTC).
 */
router.get('/vehicle-reminders', cronAuth, async (req, res) => {
  try {
    console.log('🔔 [CRON] Iniciando recordatorios de vehículos...');
    const { runVehicleReminders } = require('../services/vehicleReminderService');
    const result = await runVehicleReminders();
    res.json({
      success: true,
      message: 'Recordatorios procesados',
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ [CRON] Error en vehicle-reminders:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;