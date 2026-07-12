/* eslint-disable indent */
const axios = require('axios');
const logger = require('../config/logger');

// Envío vía API HTTP de Brevo (no SMTP) — evita el bloqueo de puertos
// salientes SMTP que aplican plataformas como Railway.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

const isEmailConfigured = () => Boolean(process.env.BREVO_API_KEY && process.env.EMAIL_FROM_ADDRESS);

// Verificar configuración
const verifyEmailConfig = async () => {
  if (!isEmailConfigured()) {
    logger.warn('[EMAIL] BREVO_API_KEY o EMAIL_FROM_ADDRESS no configurados');
    return false;
  }
  try {
    await axios.get('https://api.brevo.com/v3/account', {
      headers: { 'api-key': process.env.BREVO_API_KEY },
      timeout: 10000,
    });
    logger.info('[EMAIL] Conexión Brevo verificada');
    return true;
  } catch (error) {
    logger.error(`[EMAIL] Error verificando Brevo: ${error.message}`);
    return false;
  }
};

// ─────────────────────────────────────────
// Función base de envío
// ─────────────────────────────────────────
const sendEmail = async ({ to, subject, html, text }) => {
  try {
    if (!isEmailConfigured()) {
      logger.warn(`[EMAIL] Brevo no configurado, omitiendo envío. Para: ${to} | Asunto: ${subject}`);
      return { success: true, mode: 'log' };
    }

    const recipients = (Array.isArray(to) ? to : [to]).map((email) => ({ email }));

    const response = await axios.post(BREVO_API_URL, {
      sender: {
        name: process.env.EMAIL_FROM_NAME || 'Control de Inventario',
        email: process.env.EMAIL_FROM_ADDRESS,
      },
      to: recipients,
      subject,
      htmlContent: html,
      textContent: text || html.replace(/<[^>]*>/g, ''),
    }, {
      headers: { 'api-key': process.env.BREVO_API_KEY },
      timeout: 15000,
    });

    logger.info(`[EMAIL] Enviado a: ${to} | ID: ${response.data.messageId}`);
    return { success: true, messageId: response.data.messageId };

  } catch (error) {
    const detail = error.response?.data?.message || error.message;
    logger.error(`[EMAIL] Error enviando email a ${to}: ${detail}`);
    throw error;
  }
};

// ─────────────────────────────────────────
// Templates
// ─────────────────────────────────────────
const emailTemplates = {

  invoiceIssued: (user, invoice) => ({
    subject: `Factura #${invoice.invoice_number} emitida`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Se ha emitido tu factura correspondiente al periodo ${invoice.period_month}/${invoice.period_year}.</p>
      <p><strong>Número de factura:</strong> ${invoice.invoice_number}</p>
      <p><strong>Monto total:</strong> $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}</p>
      <p><strong>Fecha de vencimiento:</strong> ${new Date(invoice.due_date).toLocaleDateString('es-CO')}</p>
      <hr><p><small>Sistema de Control de Inventario</small></p>
    `,
    text: `Hola ${user.first_name}, factura #${invoice.invoice_number} emitida por $${invoice.total_amount}.`,
  }),

  paymentReminder: (user, invoice, daysUntilDue) => ({
    subject: `Recordatorio: Factura #${invoice.invoice_number} vence en ${daysUntilDue} días`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Tu factura #${invoice.invoice_number} vence en <strong>${daysUntilDue} días</strong>.</p>
      <p><strong>Monto pendiente:</strong> $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}</p>
      <p><strong>Fecha de vencimiento:</strong> ${new Date(invoice.due_date).toLocaleDateString('es-CO')}</p>
      <hr><p><small>Sistema de Control de Inventario</small></p>
    `,
    text: `Hola ${user.first_name}, tu factura #${invoice.invoice_number} vence en ${daysUntilDue} días.`,
  }),

  overdueAlert: (user, invoice) => ({
    subject: `⚠️ Factura #${invoice.invoice_number} vencida`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p><strong>Tu factura #${invoice.invoice_number} ha vencido.</strong></p>
      <p><strong>Monto pendiente:</strong> $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}</p>
      <hr><p><small>Sistema de Control de Inventario</small></p>
    `,
    text: `Hola ${user.first_name}, tu factura #${invoice.invoice_number} está vencida.`,
  }),

  paymentConfirmed: (user, payment, invoice) => ({
    subject: `✅ Pago confirmado - Factura #${invoice.invoice_number}`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>¡Tu pago ha sido confirmado!</p>
      <p><strong>Factura:</strong> #${invoice.invoice_number}</p>
      <p><strong>Monto pagado:</strong> $${parseFloat(payment.amount).toLocaleString('es-CO')}</p>
      <p><strong>Método:</strong> ${payment.payment_method}</p>
      <p><strong>Fecha:</strong> ${new Date(payment.payment_date).toLocaleDateString('es-CO')}</p>
      <hr><p><small>Sistema de Control de Inventario</small></p>
    `,
    text: `Hola ${user.first_name}, pago de $${payment.amount} para factura #${invoice.invoice_number} confirmado.`,
  }),

  pqrsUpdate: (user, pqrs) => ({
    subject: `Actualización PQRS #${pqrs.ticket_number}`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Tu ticket PQRS #${pqrs.ticket_number} ha sido actualizado.</p>
      <p><strong>Estado:</strong> ${pqrs.status}</p>
      <hr><p><small>Sistema de Control de Inventario</small></p>
    `,
    text: `Hola ${user.first_name}, PQRS #${pqrs.ticket_number} actualizado. Estado: ${pqrs.status}.`,
  }),

  pqrsCreated: (user, pqrs) => ({
    subject: `PQRS #${pqrs.ticket_number} creada`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Tu solicitud PQRS fue creada exitosamente.</p>
      <p><strong>Ticket:</strong> #${pqrs.ticket_number}</p>
      <p><strong>Tipo:</strong> ${pqrs.type}</p>
      <p><strong>Estado:</strong> ${pqrs.status}</p>
      <hr><p><small>Sistema de Control de Inventario</small></p>
    `,
    text: `Hola ${user.first_name}, PQRS #${pqrs.ticket_number} creada.`,
  }),

  trialExpiring: (tenant, days) => ({
    subject: `⏰ Tu período de prueba vence en ${days} ${days === 1 ? 'día' : 'días'}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#3b82f6;color:white;padding:24px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="margin:0">⏰ Período de prueba por vencer</h1>
        </div>
        <div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none">
          <p>Hola <strong>${tenant.company_name}</strong>,</p>
          <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;margin:16px 0">
            Tu período de prueba vence en <strong>${days} ${days === 1 ? 'día' : 'días'}</strong>.
          </div>
          <p>Vencimiento: <strong>${new Date(tenant.trial_ends_at).toLocaleDateString('es-CO', { year:'numeric', month:'long', day:'numeric' })}</strong></p>
          <p>Actualiza tu plan para continuar sin interrupciones.</p>
        </div>
        <div style="text-align:center;padding:16px;color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ESC Data Core Solutions</div>
      </div>
    `,
    text: `Hola ${tenant.company_name}, tu período de prueba vence en ${days} días.`,
  }),

  trialExpired: (tenant) => ({
    subject: '🔒 Tu período de prueba ha finalizado',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#ef4444;color:white;padding:24px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="margin:0">🔒 Período de prueba finalizado</h1>
        </div>
        <div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none">
          <p>Hola <strong>${tenant.company_name}</strong>,</p>
          <div style="background:#fee2e2;border-left:4px solid #ef4444;padding:12px;margin:16px 0">
            Tu período finalizó el <strong>${new Date(tenant.trial_ends_at).toLocaleDateString('es-CO')}</strong>.
          </div>
          <p>Tu cuenta fue suspendida temporalmente. Tus datos están seguros por 30 días.</p>
          <p>Selecciona un plan para reactivarla inmediatamente.</p>
        </div>
        <div style="text-align:center;padding:16px;color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ESC Data Core Solutions</div>
      </div>
    `,
    text: `Hola ${tenant.company_name}, tu período de prueba finalizó.`,
  }),

  trialExtended: (tenant, days) => ({
    subject: '✅ Tu período de prueba ha sido extendido',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#10b981;color:white;padding:24px;border-radius:8px 8px 0 0;text-align:center">
          <h1 style="margin:0">✅ ¡Buenas noticias!</h1>
        </div>
        <div style="padding:24px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none">
          <p>Hola <strong>${tenant.company_name}</strong>,</p>
          <div style="background:#d1fae5;border-left:4px solid #10b981;padding:12px;margin:16px 0">
            Tu período de prueba fue extendido por <strong>${days} días</strong>.
          </div>
          <p>Nueva fecha de vencimiento: <strong>${new Date(tenant.trial_ends_at).toLocaleDateString('es-CO', { year:'numeric', month:'long', day:'numeric' })}</strong></p>
        </div>
        <div style="text-align:center;padding:16px;color:#6b7280;font-size:12px">© ${new Date().getFullYear()} ESC Data Core Solutions</div>
      </div>
    `,
    text: `Hola ${tenant.company_name}, período extendido por ${days} días.`,
  }),
};

// ─────────────────────────────────────────
// Funciones específicas
// ─────────────────────────────────────────

const sendInvoiceEmail = async (tenantId, invoice) => {
  const user = invoice.client || invoice.user;
  if (!user?.email) return { success: false, reason: 'no_email' };
  const t = emailTemplates.invoiceIssued(user, invoice);
  return sendEmail({ to: user.email, subject: t.subject, html: t.html, text: t.text });
};

const sendPaymentEmail = async (tenantId, payment) => {
  const user = payment.user || payment.invoice?.client || payment.invoice?.user;
  const invoice = payment.invoice;
  if (!user?.email) return { success: false, reason: 'no_email' };
  if (!invoice)     return { success: false, reason: 'no_invoice' };
  const t = emailTemplates.paymentConfirmed(user, payment, invoice);
  return sendEmail({ to: user.email, subject: t.subject, html: t.html, text: t.text });
};

const sendPaymentReminderEmail = async (tenantId, invoice, daysUntilDue = 7) => {
  const user = invoice.client || invoice.user;
  if (!user?.email) return { success: false, reason: 'no_email' };
  const t = emailTemplates.paymentReminder(user, invoice, daysUntilDue);
  return sendEmail({ to: user.email, subject: t.subject, html: t.html, text: t.text });
};

const sendOverdueEmail = async (tenantId, invoice) => {
  const user = invoice.client || invoice.user;
  if (!user?.email) return { success: false, reason: 'no_email' };
  const t = emailTemplates.overdueAlert(user, invoice);
  return sendEmail({ to: user.email, subject: t.subject, html: t.html, text: t.text });
};

const sendPQRSEmail = async (tenantId, pqrs) => {
  const user = pqrs.user || pqrs.client;
  if (!user?.email) return { success: false, reason: 'no_email' };
  const t = emailTemplates.pqrsUpdate(user, pqrs);
  return sendEmail({ to: user.email, subject: t.subject, html: t.html, text: t.text });
};

const sendInvoiceReminderEmail  = (tenantId, invoice, days = 7) => sendPaymentReminderEmail(tenantId, invoice, days);
const sendPaymentConfirmationEmail = (tenantId, payment) => sendPaymentEmail(tenantId, payment);

const sendPQRSCreatedEmail = async (tenantId, pqrs) => {
  const user = pqrs.user || pqrs.client;
  if (!user?.email) return { success: false, reason: 'no_email' };
  const t = emailTemplates.pqrsCreated(user, pqrs);
  return sendEmail({ to: user.email, subject: t.subject, html: t.html, text: t.text });
};

const sendPQRSUpdatedEmail = (tenantId, pqrs) => sendPQRSEmail(tenantId, pqrs);

module.exports = {
  sendEmail,
  verifyEmailConfig,
  emailTemplates,
  sendInvoiceEmail,
  sendPaymentEmail,
  sendPaymentReminderEmail,
  sendOverdueEmail,
  sendPQRSEmail,
  sendInvoiceReminderEmail,
  sendPaymentConfirmationEmail,
  sendPQRSCreatedEmail,
  sendPQRSUpdatedEmail,
};