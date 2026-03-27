// backend/src/services/vehicleReminderService.js
//
// Recordatorios de vencimiento de SOAT y Tecnomecánica.
// Canal único: Email (Gmail).
// Se ejecuta vía cron diario desde /api/cron/vehicle-reminders.
// Días de anticipación: 15, 7 y 3 días antes del vencimiento.

const { Op }        = require('sequelize');
const { sendEmail } = require('./emailService');

const REMINDER_DAYS = [15, 7, 3];

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildReminderContent(type, vehicle, customer, daysLeft, workshopName) {
  const TYPE_LABELS  = { soat: 'SOAT', tecnomecanica: 'Técnico-Mecánica' };
  const typeLabel    = TYPE_LABELS[type] || type;
  const expiryDate   = type === 'soat' ? vehicle.soat_expiry : vehicle.tecnomecanica_expiry;
  const customerName = customer.business_name || `${customer.first_name} ${customer.last_name || ''}`.trim();
  const plate        = vehicle.plate?.toUpperCase();

  const urgencyEmoji = daysLeft <= 3 ? '🚨' : daysLeft <= 7 ? '⚠️' : '📅';
  const urgencyText  = daysLeft <= 3 ? 'URGENTE' : daysLeft <= 7 ? 'Pronto' : 'Próximo';
  const accentColor  = daysLeft <= 3 ? '#ef4444' : daysLeft <= 7 ? '#f59e0b' : '#3b82f6';
  const bgColor      = daysLeft <= 3 ? '#fef2f2' : daysLeft <= 7 ? '#fffbeb' : '#eff6ff';

  const emailSubject = `${urgencyEmoji} ${urgencyText}: Tu ${typeLabel} (${plate}) vence en ${daysLeft} día${daysLeft > 1 ? 's' : ''}`;

  const emailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9fafb">
      <div style="background:${accentColor};color:white;padding:24px;border-radius:12px 12px 0 0;text-align:center">
        <h1 style="margin:0;font-size:22px">${urgencyEmoji} Recordatorio de vencimiento</h1>
        <p style="margin:8px 0 0;opacity:0.85;font-size:14px">${typeLabel} — ${urgencyText}</p>
      </div>
      <div style="padding:24px;background:white;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:16px;color:#111">Hola <strong>${customerName}</strong>,</p>
        <div style="background:${bgColor};border-left:4px solid ${accentColor};padding:14px 16px;margin:16px 0;border-radius:0 8px 8px 0">
          <p style="margin:0;font-size:15px;color:#374151">
            El <strong>${typeLabel}</strong> de tu vehículo <strong>${plate}</strong> vence en
            <strong style="font-size:18px"> ${daysLeft} día${daysLeft > 1 ? 's' : ''}</strong>.
          </p>
          <p style="margin:6px 0 0;font-size:13px;color:#6b7280">Fecha de vencimiento: <strong>${expiryDate}</strong></p>
        </div>
        <p style="font-size:14px;color:#4b5563">
          Te recordamos que circular con el ${typeLabel} vencido puede generar multas y problemas legales. ¡Renuévalo a tiempo!
        </p>
        <p style="font-size:14px;color:#374151;margin-top:20px">Con gusto te atendemos,<br><strong>${workshopName || 'Tu taller de confianza'}</strong></p>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:11px;padding:12px">
        Este recordatorio fue enviado automáticamente por ${workshopName}.
      </p>
    </div>
  `;

  return { emailSubject, emailHtml };
}

async function sendReminder(vehicle, customer, type, daysLeft, workshopName, results) {
  try {
    const { emailSubject, emailHtml } = buildReminderContent(type, vehicle, customer, daysLeft, workshopName);

    if (!customer.email) {
      results.skipped++;
      console.warn(`⚠️ [REMINDER] Cliente sin email: ${customer.id} (${vehicle.plate})`);
      return;
    }

    await sendEmail({ to: customer.email, subject: emailSubject, html: emailHtml });

    results.sent++;
    results.details.push({
      vehicle:  vehicle.plate,
      customer: customer.first_name,
      type,
      daysLeft,
      channel: 'email',
    });
  } catch (err) {
    results.errors++;
    console.error(`❌ [REMINDER] Error enviando a ${vehicle.plate}:`, err.message);
  }
}

async function runVehicleReminders() {
  const Vehicle  = require('../models/workshop/Vehicle');
  const Customer = require('../models/sales/Customer');
  const Tenant   = require('../models/auth/Tenant');

  const results = { sent: 0, skipped: 0, errors: 0, details: [], skippedDetails: [] };

  // Construir fechas target en zona horaria de Colombia (UTC-5)
  // Se usa toISOString() + slice para evitar problemas de conversión local
  const targetDates = REMINDER_DAYS.map(days => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    // Ajuste a medianoche UTC-5 (Colombia) para comparar con fechas DATEONLY de Postgres
    const bogota = new Date(d.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    return bogota.toISOString().slice(0, 10);
  });

  console.log(`🔔 [REMINDER] Verificando vencimientos para: ${targetDates.join(', ')}`);

  const vehicles = await Vehicle.findAll({
    where: {
      is_active: true,
      [Op.or]: [
        { soat_expiry:          { [Op.in]: targetDates } },
        { tecnomecanica_expiry: { [Op.in]: targetDates } },
      ],
    },
    include: [{
      model:      Customer,
      as:         'customer',
      required:   false,
      attributes: ['id', 'first_name', 'last_name', 'business_name', 'email', 'phone', 'mobile'],
    }],
  });

  console.log(`🔔 [REMINDER] Vehículos encontrados: ${vehicles.length}`);

  // Precargar tenants únicos para evitar N+1
  const tenantIds  = [...new Set(vehicles.map(v => v.tenant_id))];
  const tenants    = await Tenant.findAll({ where: { id: tenantIds }, attributes: ['id', 'company_name'] });
  const tenantMap  = Object.fromEntries(tenants.map(t => [t.id, t.company_name]));

  for (const vehicle of vehicles) {
    const customer     = vehicle.customer;
    const workshopName = tenantMap[vehicle.tenant_id] || 'Tu taller';

    // Sin cliente asociado
    if (!customer) {
      results.skipped++;
      results.skippedDetails.push({ plate: vehicle.plate, reason: 'sin_cliente' });
      console.warn(`⚠️ [REMINDER] ${vehicle.plate} — sin cliente asociado`);
      continue;
    }

    // Sin email
    if (!customer.email) {
      results.skipped++;
      results.skippedDetails.push({ plate: vehicle.plate, reason: 'cliente_sin_email', customer: customer.id });
      console.warn(`⚠️ [REMINDER] ${vehicle.plate} — cliente ${customer.id} sin email`);
      continue;
    }

    // Normalizar fecha de Postgres (viene como Date object o string) a YYYY-MM-DD
    const soatDate   = vehicle.soat_expiry          ? String(vehicle.soat_expiry).slice(0, 10)   : null;
    const tecnoDate  = vehicle.tecnomecanica_expiry  ? String(vehicle.tecnomecanica_expiry).slice(0, 10) : null;

    if (soatDate && targetDates.includes(soatDate)) {
      const daysLeft = REMINDER_DAYS.find(d => targetDates[REMINDER_DAYS.indexOf(d)] === soatDate);
      await sendReminder(vehicle, customer, 'soat', daysLeft, workshopName, results);
    }

    if (tecnoDate && targetDates.includes(tecnoDate)) {
      const daysLeft = REMINDER_DAYS.find(d => targetDates[REMINDER_DAYS.indexOf(d)] === tecnoDate);
      await sendReminder(vehicle, customer, 'tecnomecanica', daysLeft, workshopName, results);
    }
  }

  console.log(`✅ [REMINDER] Completado — Enviados: ${results.sent} | Omitidos: ${results.skipped} | Errores: ${results.errors}`);
  if (results.skippedDetails.length > 0) {
    console.log(`   Omitidos detalle:`, JSON.stringify(results.skippedDetails));
  }
  return results;
}

module.exports = { runVehicleReminders };