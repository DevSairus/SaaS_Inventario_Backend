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
// Vercel Cron Jobs llama el endpoint directamente sin Authorization header,
// pero sí envía el header x-vercel-cron: 1 en producción.
// El Bearer token sigue funcionando para llamadas manuales (Postman, etc).
const cronAuth = (req, res, next) => {
  // Llamada automática de Vercel Cron (producción)
  if (req.headers['x-vercel-cron'] === '1') {
    return next();
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
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


// ============================================================================
// TEST ENDPOINT — Solo disponible en desarrollo o con CRON_SECRET
// POST /api/cron/test-reminder
// Body: { plate?: string, days?: number, type?: 'soat'|'tecnomecanica'|'both' }
//
// Ejemplos:
//   { "days": 7 }                          → todos los vehículos que venzan en 7 días
//   { "plate": "ABC123", "days": 7 }       → solo esa placa, simula 7 días
//   { "plate": "ABC123", "days": 3, "type": "soat" } → solo SOAT
// ============================================================================
router.post('/test-reminder', cronAuth, async (req, res) => {
  try {
    const Vehicle  = require('../models/workshop/Vehicle');
    const Customer = require('../models/sales/Customer');
    const Tenant   = require('../models/auth/Tenant');
    const { sendEmail }   = require('../services/emailService');

    const { tenant_id, plate, days = 7, type = 'both' } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ success: false, message: 'Falta tenant_id en el body.' });
    }

    // Buscar vehículo(s) del tenant indicado
    const where = { is_active: true, tenant_id };
    if (plate) where.plate = plate.toUpperCase();

    // Validar que el tenant existe
    const tenantCheck = await Tenant.findByPk(tenant_id, { attributes: ['id', 'company_name'] });
    if (!tenantCheck) {
      return res.status(404).json({ success: false, message: `Tenant ${tenant_id} no encontrado.` });
    }

    const vehicles = await Vehicle.findAll({
      where,
      include: [{
        model: Customer,
        as: 'customer',
        required: false,
        attributes: ['id', 'first_name', 'last_name', 'business_name', 'email', 'phone', 'mobile'],
      }],
      limit: plate ? 1 : 5, // Sin placa: máx 5 para no spamear
    });

    if (!vehicles.length) {
      return res.status(404).json({ success: false, message: plate ? `Vehículo ${plate} no encontrado` : 'No hay vehículos activos' });
    }

    const results = [];

    for (const vehicle of vehicles) {
      const customer = vehicle.customer;
      const tenant   = await Tenant.findByPk(tenant_id, { attributes: ['company_name'] });
      const workshopName = tenant?.company_name || 'Tu taller';

      const types = type === 'both' ? ['soat', 'tecnomecanica'] : [type];

      for (const docType of types) {
        const typeLabel    = docType === 'soat' ? 'SOAT' : 'Técnico-Mecánica';
        const urgencyEmoji = days <= 3 ? '🚨' : days <= 7 ? '⚠️' : '📅';
        const urgencyText  = days <= 3 ? 'URGENTE' : days <= 7 ? 'Pronto' : 'Próximo';
        const customerName = customer
          ? (customer.business_name || `${customer.first_name} ${customer.last_name || ''}`.trim())
          : 'Cliente';
        const plate_upper = vehicle.plate?.toUpperCase();

        const fakeExpiry = new Date();
        fakeExpiry.setDate(fakeExpiry.getDate() + Number(days));
        const expiryDate = fakeExpiry.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });

        let channel = null;

        // Enviar por email
        if (customer?.email) {
          try {
            await sendEmail({
              to: customer.email,
              subject: `[PRUEBA] ${urgencyEmoji} Tu ${typeLabel} (${plate_upper}) vence en ${days} día${days > 1 ? 's' : ''}`,
              html: `<p>Este es un mensaje de <strong>prueba</strong>.<br>Vehículo: <strong>${plate_upper}</strong><br>Documento: <strong>${typeLabel}</strong><br>Días simulados: <strong>${days}</strong></p>`,
            });
            channel = 'email';
          } catch (e) {
            channel = `email_error: ${e.message}`;
          }
        }

        results.push({
          plate: plate_upper,
          customer: customerName,
          type: docType,
          days_simulated: days,
          phone: phone || null,
          email: customer?.email || null,
          channel: channel || 'sin_contacto',
        });
      }
    }

    res.json({
      success: true,
      message: `Prueba completada — ${results.length} recordatorio(s) procesado(s)`,
      results,
      note: 'Los mensajes llevan el prefijo [PRUEBA] para distinguirlos de los reales',
    });
  } catch (error) {
    console.error('❌ [TEST-REMINDER] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;