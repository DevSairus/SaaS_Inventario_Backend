// backend/src/services/vehicleReminderService.js
//
// Servicio de recordatorios de vencimiento de SOAT y Tecnomecánica.
// Se ejecuta vía cron job diario desde /api/cron/vehicle-reminders
// (configurado en vercel.json con CRON_SECRET para protección).
//
// Lógica: Envía notificación cuando el vencimiento es exactamente
// 15, 7 o 3 días desde hoy.
// Canal preferido: WhatsApp (Twilio) → fallback Email (Gmail).

const { Op } = require('sequelize');
const { sendEmail } = require('./emailService');
const { formatPhoneNumber } = require('../config/sms');

// Días de anticipación para los recordatorios
const REMINDER_DAYS = [15, 7, 3];

/**
 * Obtiene la fecha que corresponde a "hoy + N días" sin hora (solo fecha).
 */
function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Envía un SMS/WhatsApp de recordatorio via Twilio.
 * Retorna true si se envió, false si no hay configuración.
 */
async function sendWhatsApp(phone, message) {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_FROM) {
      return false; // Twilio no configurado
    }
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const formattedPhone = formatPhoneNumber(phone);

    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      to:   `whatsapp:${formattedPhone}`,
      body: message,
    });

    console.log(`✅ [REMINDER] WhatsApp enviado a ${formattedPhone}`);
    return true;
  } catch (err) {
    console.error('❌ [REMINDER] Error enviando WhatsApp:', err.message);
    return false;
  }
}

/**
 * Construye el mensaje/email de recordatorio.
 */
function buildReminderContent(type, vehicle, customer, daysLeft, workshopName) {
  const typeLabel    = type === 'soat' ? 'SOAT' : 'Técnico-Mecánica';
  const expiryField  = type === 'soat' ? vehicle.soat_expiry : vehicle.tecnomecanica_expiry;
  const expiryDate   = new Date(expiryField).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
  const customerName = customer.business_name || `${customer.first_name} ${customer.last_name || ''}`.trim();
  const plate        = vehicle.plate?.toUpperCase();

  const urgencyEmoji = daysLeft <= 3 ? '🚨' : daysLeft <= 7 ? '⚠️' : '📅';
  const urgencyText  = daysLeft <= 3 ? 'URGENTE' : daysLeft <= 7 ? 'Pronto' : 'Próximo';

  const whatsappMsg = [
    `${urgencyEmoji} *Recordatorio ${urgencyText}* — ${typeLabel}`,
    ``,
    `Hola *${customerName}*,`,
    ``,
    `Tu vehículo *${plate}* tiene el *${typeLabel}* venciendo en *${daysLeft} día${daysLeft > 1 ? 's'  : ''}* (${expiryDate}).`,
    ``,
    `Renuévalo a tiempo para evitar multas y conducir con tranquilidad. 😊`,
    ``,
    `— ${workshopName || 'Tu taller de confianza'}`,
  ].join('\n');

  const emailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9fafb">
      <div style="background:${daysLeft <= 3 ? '#ef4444' : daysLeft <= 7 ? '#f59e0b' : '#3b82f6'};color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center">
        <h1 style="margin:0;font-size:22px">${urgencyEmoji} Recordatorio de vencimiento</h1>
        <p style="margin:8px 0 0;opacity:0.85;font-size:14px">${typeLabel} — ${urgencyText}</p>
      </div>
      <div style="padding:24px;background:white;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:16px;color:#111">Hola <strong>${customerName}</strong>,</p>
        <div style="background:${daysLeft <= 3 ? '#fef2f2' : daysLeft <= 7 ? '#fffbeb' : '#eff6ff'};border-left:4px solid ${daysLeft <= 3 ? '#ef4444' : daysLeft <= 7 ? '#f59e0b' : '#3b82f6'};padding:14px 16px;margin:16px 0;border-radius:0 8px 8px 0">
          <p style="margin:0;font-size:15px;color:#374151">
            El <strong>${typeLabel}</strong> de tu vehículo <strong>${plate}</strong> vence en
            <strong style="font-size:18px"> ${daysLeft} día${daysLeft > 1 ? 's' : ''}</strong>.
          </p>
          <p style="margin:6px 0 0;font-size:13px;color:#6b7280">Fecha de vencimiento: <strong>${expiryDate}</strong></p>
        </div>
        <p style="font-size:14px;color:#4b5563">
          Te recordamos que circular con el ${typeLabel} vencido puede generar multas y problemas legales.
          ¡Renuévalo a tiempo!
        </p>
        <p style="font-size:14px;color:#4b5563">Si necesitas ayuda o tienes preguntas, no dudes en contactarnos.</p>
        <p style="font-size:14px;color:#374151;margin-top:20px">Con gusto te atendemos,<br><strong>${workshopName || 'Tu taller de confianza'}</strong></p>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:11px;padding:12px">
        Este recordatorio fue enviado automáticamente por ${workshopName}.
      </p>
    </div>
  `;

  return {
    whatsappMsg,
    emailSubject: `${urgencyEmoji} ${urgencyText}: Tu ${typeLabel} (${plate}) vence en ${daysLeft} día${daysLeft > 1 ? 's' : ''}`,
    emailHtml,
  };
}

/**
 * Función principal del recordatorio.
 * Retorna un resumen de lo que se envió.
 */
async function runVehicleReminders() {
  const Vehicle  = require('../models/workshop/Vehicle');
  const Customer = require('../models/sales/Customer');
  const Tenant   = require('../models/auth/Tenant');

  const results = { sent: 0, skipped: 0, errors: 0, details: [] };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Construir array de fechas objetivo
  const targetDates = REMINDER_DAYS.map(days => {
    const d = addDays(days);
    return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  });

  console.log(`🔔 [REMINDER] Verificando vencimientos para fechas: ${targetDates.join(', ')}`);

  // Buscar vehículos con SOAT o Tecnomecánica venciendo en esos días
  const vehicles = await Vehicle.findAll({
    where: {
      is_active: true,
      [Op.or]: [
        { soat_expiry:         { [Op.in]: targetDates } },
        { tecnomecanica_expiry: { [Op.in]: targetDates } },
      ],
    },
    include: [
      {
        model: Customer,
        as: 'customer',
        required: false,
        attributes: ['id', 'first_name', 'last_name', 'business_name', 'email', 'phone', 'mobile'],
      },
    ],
  });

  console.log(`🔔 [REMINDER] Vehículos encontrados: ${vehicles.length}`);

  for (const vehicle of vehicles) {
    const customer = vehicle.customer;
    if (!customer) {
      results.skipped++;
      continue;
    }

    // Obtener nombre del taller
    const tenant = await Tenant.findByPk(vehicle.tenant_id, {
      attributes: ['company_name', 'phone'],
    });
    const workshopName = tenant?.company_name || 'Tu taller';

    // ─ SOAT ─────────────────────────────────────────────────────────────
    if (vehicle.soat_expiry && targetDates.includes(vehicle.soat_expiry)) {
      const daysLeft = REMINDER_DAYS.find(d => addDays(d).toISOString().slice(0, 10) === vehicle.soat_expiry);
      await sendReminder(vehicle, customer, 'soat', daysLeft, workshopName, results);
    }

    // ─ Tecnomecánica ────────────────────────────────────────────────────
    if (vehicle.tecnomecanica_expiry && targetDates.includes(vehicle.tecnomecanica_expiry)) {
      const daysLeft = REMINDER_DAYS.find(d => addDays(d).toISOString().slice(0, 10) === vehicle.tecnomecanica_expiry);
      await sendReminder(vehicle, customer, 'tecnomecanica', daysLeft, workshopName, results);
    }
  }

  console.log(`✅ [REMINDER] Completado. Enviados: ${results.sent} | Omitidos: ${results.skipped} | Errores: ${results.errors}`);
  return results;
}

/**
 * Envía un recordatorio individual (WhatsApp o email).
 */
async function sendReminder(vehicle, customer, type, daysLeft, workshopName, results) {
  try {
    const { whatsappMsg, emailSubject, emailHtml } = buildReminderContent(
      type, vehicle, customer, daysLeft, workshopName
    );

    const phone = customer.mobile || customer.phone;
    let sent = false;

    // Intentar WhatsApp primero
    if (phone) {
      sent = await sendWhatsApp(phone, whatsappMsg);
    }

    // Fallback a email
    if (!sent && customer.email) {
      await sendEmail({ to: customer.email, subject: emailSubject, html: emailHtml });
      sent = true;
    }

    if (sent) {
      results.sent++;
      results.details.push({
        vehicle: vehicle.plate,
        customer: customer.first_name,
        type,
        daysLeft,
        channel: phone && sent ? 'whatsapp' : 'email',
      });
    } else {
      results.skipped++;
      console.warn(`⚠️ [REMINDER] Sin canal de contacto para cliente ${customer.id} (${vehicle.plate})`);
    }
  } catch (err) {
    results.errors++;
    console.error(`❌ [REMINDER] Error enviando a ${vehicle.plate}:`, err.message);
  }
}

module.exports = { runVehicleReminders };