// backend/src/services/vehicleReminderService.js
//
// Recordatorios de vencimiento de SOAT y Técnico-Mecánica.
// Se ejecuta a diario (jobs/scheduler.js, 8:00 a. m. Colombia, o vía
// /api/cron/vehicle-reminders) y recorre cada tenant en su schema.
//
// Configuración por tenant en business_config.vehicle_reminders (Ajustes →
// pestaña Taller), ver getReminderSettings:
//   enabled            activo (sí por defecto, como venía funcionando)
//   days_before        días de anticipación (15, 7 y 3 por defecto)
//   email / whatsapp   canales
//   whatsapp_template  plantilla de Meta, categoría Servicio, con 4 variables
//                      en el cuerpo: {{1}} nombre del cliente, {{2}} documento
//                      (SOAT / revisión técnico-mecánica), {{3}} placa y
//                      {{4}} fecha de vencimiento. Un envío automático solo
//                      sale por WhatsApp con plantilla, salvo que el cliente
//                      haya escrito en las últimas 24 h.
//
// Solo se avisa ANTES del vencimiento: el cliente pudo renovarlo por su
// cuenta y un "se te venció" le cae mal (decisión del negocio, 2026-10-29).
//
// Cada intento queda en vehicle_reminder_logs (enviado, fallido u omitido,
// con el motivo): se muestra en la ficha del vehículo y evita repetir un
// aviso que ya salió si el job corre dos veces el mismo día.

const { Op } = require('sequelize');
const { sendEmail } = require('./emailService');
const { getCustomerWhatsappNumber } = require('../utils/customerWhatsappPhone');

const DEFAULT_SETTINGS = {
  enabled: true,
  days_before: [15, 7, 3],
  email: true,
  whatsapp: false,
  whatsapp_template: '',
  whatsapp_language: 'es',
};
const MAX_DAYS = 90;
const MAX_REMINDERS = 5;

const TYPE_LABELS = { soat: 'SOAT', tecnomecanica: 'Técnico-Mecánica' };
const TYPE_LONG = { soat: 'SOAT', tecnomecanica: 'revisión técnico-mecánica' };

function sanitizeDays(days) {
  const list = (Array.isArray(days) ? days : String(days ?? '').split(/[,\s;]+/))
    .map((d) => parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= MAX_DAYS);
  return [...new Set(list)].sort((a, b) => b - a).slice(0, MAX_REMINDERS);
}

function getReminderSettings(tenant) {
  const raw = { ...DEFAULT_SETTINGS, ...(tenant?.business_config?.vehicle_reminders || {}) };
  const days = sanitizeDays(raw.days_before);
  return {
    enabled: raw.enabled !== false,
    days_before: days.length ? days : DEFAULT_SETTINGS.days_before,
    email: raw.email !== false,
    whatsapp: raw.whatsapp === true,
    whatsapp_template: String(raw.whatsapp_template || '').trim(),
    whatsapp_language: String(raw.whatsapp_language || 'es').trim() || 'es',
  };
}

// Fecha YYYY-MM-DD de hoy en Colombia más `days` días, sin depender de la
// zona horaria del servidor.
function bogotaDatePlus(days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDateEs(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function customerNameOf(customer) {
  return customer.business_name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'cliente';
}

function buildReminderContent(type, plate, expiryDate, customerName, daysLeft, workshopName) {
  const typeLabel = TYPE_LABELS[type] || type;
  const expiryText = fmtDateEs(expiryDate);
  const dayWord = `día${daysLeft > 1 ? 's' : ''}`;

  const urgencyEmoji = daysLeft <= 3 ? '🚨' : daysLeft <= 7 ? '⚠️' : '📅';
  const urgencyText  = daysLeft <= 3 ? 'URGENTE' : daysLeft <= 7 ? 'Pronto' : 'Próximo';
  const accentColor  = daysLeft <= 3 ? '#ef4444' : daysLeft <= 7 ? '#f59e0b' : '#3b82f6';
  const bgColor      = daysLeft <= 3 ? '#fef2f2' : daysLeft <= 7 ? '#fffbeb' : '#eff6ff';

  const emailSubject = `${urgencyEmoji} ${urgencyText}: Tu ${typeLabel} (${plate}) vence en ${daysLeft} ${dayWord}`;

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
            <strong style="font-size:18px"> ${daysLeft} ${dayWord}</strong>.
          </p>
          <p style="margin:6px 0 0;font-size:13px;color:#6b7280">Fecha de vencimiento: <strong>${expiryText}</strong></p>
        </div>
        <p style="font-size:14px;color:#4b5563">
          Te recordamos que circular con el ${typeLabel} vencido puede generar multas y problemas legales. ¡Renuévalo a tiempo!
          Si ya lo renovaste, no tengas en cuenta este mensaje.
        </p>
        <p style="font-size:14px;color:#374151;margin-top:20px">Con gusto te atendemos,<br><strong>${workshopName || 'Tu taller de confianza'}</strong></p>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:11px;padding:12px">
        Este recordatorio fue enviado automáticamente por ${workshopName}.
      </p>
    </div>
  `;

  // Texto para WhatsApp cuando no hay plantilla (solo sale con la ventana
  // de 24 h abierta).
  const whatsappText = `*${workshopName}*\nHola ${customerName}, te recordamos que el ${TYPE_LONG[type]} de tu vehículo *${plate}* vence el *${expiryText}* (en ${daysLeft} ${dayWord}). Si ya lo renovaste, no tengas en cuenta este mensaje.`;

  return { emailSubject, emailHtml, whatsappText, expiryText };
}

// Ya salió alguna vez, o ya se intentó hoy (si el job corre dos veces el
// mismo día no se repiten los omitidos ni los fallidos en el historial).
async function alreadyHandled(VehicleReminderLog, key, since) {
  const { vehicle_id, document_type, expiry_date, days_before, channel } = key;
  return !!(await VehicleReminderLog.findOne({
    where: {
      vehicle_id, document_type, expiry_date, days_before, channel,
      [Op.or]: [{ status: 'sent' }, { created_at: { [Op.gte]: since } }],
    },
    attributes: ['id'],
  }));
}

async function log(VehicleReminderLog, key, status, destination, detail, results) {
  try {
    await VehicleReminderLog.create({ ...key, status, destination: destination || null, detail: detail || null });
  } catch (err) {
    // El índice único de 'sent' rechaza un duplicado: no es un error real.
    if (err.name !== 'SequelizeUniqueConstraintError') console.error(`❌ [REMINDER] No se pudo registrar el historial: ${err.message}`);
  }
  if (status === 'sent') results.sent++;
  else if (status === 'failed') results.errors++;
  else results.skipped++;
}

async function sendEmailReminder({ key, customer, content, VehicleReminderLog, results }) {
  if (!customer.email) return log(VehicleReminderLog, key, 'skipped', null, 'El cliente no tiene correo', results);
  try {
    await sendEmail({ to: customer.email, subject: content.emailSubject, html: content.emailHtml });
    return log(VehicleReminderLog, key, 'sent', customer.email, null, results);
  } catch (err) {
    return log(VehicleReminderLog, key, 'failed', customer.email, err.message, results);
  }
}

async function sendWhatsappReminder({ key, tenant, customer, content, plate, settings, waStatus, VehicleReminderLog, results }) {
  const phone = getCustomerWhatsappNumber(customer);
  if (!phone) return log(VehicleReminderLog, key, 'skipped', null, 'El cliente no tiene celular', results);
  if (!waStatus?.operational) return log(VehicleReminderLog, key, 'failed', phone, 'WhatsApp no está conectado', results);
  const waCloud = require('./whatsappCloud.service');
  try {
    if (settings.whatsapp_template && !waStatus.demo_mode) {
      await waCloud.sendTemplateFromTenant({
        tenantId: tenant.id,
        to: phone,
        templateName: settings.whatsapp_template,
        language: settings.whatsapp_language,
        components: [{
          type: 'body',
          parameters: [customerNameOf(customer), TYPE_LONG[key.document_type], plate, content.expiryText]
            .map((text) => ({ type: 'text', text: String(text) })),
        }],
        source: 'api',
      });
    } else {
      await waCloud.sendTextFromTenant({ tenantId: tenant.id, to: phone, body: content.whatsappText, source: 'api' });
    }
    return log(VehicleReminderLog, key, 'sent', phone, null, results);
  } catch (err) {
    const detail = err.code === 'WA_WINDOW_CLOSED'
      ? 'Sin plantilla de WhatsApp y el cliente no ha escrito en las últimas 24 h'
      : err.message;
    return log(VehicleReminderLog, key, 'failed', phone, detail, results);
  }
}

// Procesa los vehículos de UN tenant. Debe correr con el schema de ese tenant
// activo (public para los tenants legados, o dentro de runWithTenantSchema).
async function processTenantReminders(tenant, results) {
  const settings = getReminderSettings(tenant);
  if (!settings.enabled || (!settings.email && !settings.whatsapp)) return;

  const { Vehicle, Customer, VehicleReminderLog } = require('../models');
  const daysByDate = new Map(settings.days_before.map((d) => [bogotaDatePlus(d), d]));
  const targetDates = [...daysByDate.keys()];

  const vehicles = await Vehicle.findAll({
    where: {
      tenant_id: tenant.id,
      is_active: true,
      [Op.or]: [
        { soat_expiry: { [Op.in]: targetDates } },
        { tecnomecanica_expiry: { [Op.in]: targetDates } },
      ],
    },
    include: [{
      model: Customer,
      as: 'customer',
      required: false,
      attributes: ['id', 'first_name', 'last_name', 'business_name', 'email', 'phone', 'mobile', 'mobile_country_code', 'habeas_data_status'],
    }],
  });
  if (!vehicles.length) return;
  console.log(`🔔 [REMINDER] ${tenant.company_name}: ${vehicles.length} vehículo(s) con vencimiento en ${settings.days_before.join(', ')} días`);

  let waStatus = null;
  if (settings.whatsapp) {
    try {
      waStatus = await require('./whatsappCloud.service').getWhatsAppStatus(tenant.id);
    } catch (err) {
      console.warn(`⚠️ [REMINDER] No se pudo consultar WhatsApp de ${tenant.company_name}: ${err.message}`);
    }
  }
  const channels = [settings.email && 'email', settings.whatsapp && 'whatsapp'].filter(Boolean);
  const startOfToday = new Date(`${bogotaDatePlus(0)}T00:00:00-05:00`);
  const workshopName = tenant.company_name || 'Tu taller';

  for (const vehicle of vehicles) {
    const customer = vehicle.customer;
    const plate = vehicle.plate?.toUpperCase();
    const docs = [
      ['soat', vehicle.soat_expiry],
      ['tecnomecanica', vehicle.tecnomecanica_expiry],
    ]
      .map(([type, date]) => [type, date ? String(date).slice(0, 10) : null])
      .filter(([, date]) => date && daysByDate.has(date));

    for (const [type, expiryDate] of docs) {
      const daysLeft = daysByDate.get(expiryDate);
      for (const channel of channels) {
        const key = {
          tenant_id: tenant.id, vehicle_id: vehicle.id, customer_id: customer?.id || null,
          document_type: type, expiry_date: expiryDate, days_before: daysLeft, channel,
        };
        if (await alreadyHandled(VehicleReminderLog, key, startOfToday)) continue;

        if (!customer) { await log(VehicleReminderLog, key, 'skipped', null, 'El vehículo no tiene cliente', results); continue; }
        // Habeas data: si el titular la rechazó o la revocó, no se le escribe
        // (los recordatorios son la finalidad 2.2.h del documento). Sin
        // solicitud aún (null/pending) se sigue enviando.
        if (['rejected', 'revoked'].includes(customer.habeas_data_status)) {
          await log(VehicleReminderLog, key, 'skipped', null, 'El cliente no autorizó el tratamiento de datos', results);
          continue;
        }

        const content = buildReminderContent(type, plate, expiryDate, customerNameOf(customer), daysLeft, workshopName);
        if (channel === 'email') await sendEmailReminder({ key, customer, content, VehicleReminderLog, results });
        else await sendWhatsappReminder({ key, tenant, customer, content, plate, settings, waStatus, VehicleReminderLog, results });
      }
    }
  }
}

async function runVehicleReminders() {
  const Tenant = require('../models/auth/Tenant');
  const { runWithTenantSchema } = require('../config/tenantContext');

  const results = { sent: 0, skipped: 0, errors: 0 };
  // Cada tenant en su schema: fuera de un request HTTP, sin contexto, las
  // consultas resolverían contra `public` y los tenants ya cortados a su
  // propio schema quedarían invisibles.
  const tenants = await Tenant.findAll({ attributes: ['id', 'schema_name', 'company_name', 'business_config'] });
  for (const tenant of tenants) {
    try {
      if (tenant.schema_name) await runWithTenantSchema(tenant.schema_name, () => processTenantReminders(tenant, results));
      else await processTenantReminders(tenant, results);
    } catch (err) {
      results.errors++;
      console.error(`❌ [REMINDER] Error procesando ${tenant.company_name}:`, err.message);
    }
  }

  console.log(`✅ [REMINDER] Completado — Enviados: ${results.sent} | Omitidos: ${results.skipped} | Fallidos: ${results.errors}`);
  return results;
}

module.exports = { runVehicleReminders, getReminderSettings, DEFAULT_SETTINGS };
