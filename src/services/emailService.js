/* eslint-disable indent */
const nodemailer = require('nodemailer');

// Configurar transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false, // true para 465, false para otros puertos
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verificar conexión al iniciar
const verifyEmailConfig = async () => {
  try {
    // Si no hay configuración, solo advertir
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return false;
    }

    await transporter.verify();
    return true;
  } catch (error) {
    return false;
  }
};

// Enviar email
const sendEmail = async ({ to, subject, html, text }) => {
  try {
    // Si no hay configuración de email, solo hacer log
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.log(
        '⚠️ [EMAIL] Configuración SMTP no disponible, omitiendo envío'
      );
      return { success: true, mode: 'log' };
    }

    const info = await transporter.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'Sistema Acueductos'}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text: text || html.replace(/<[^>]*>/g, ''), // Fallback a texto plano
      html,
    });

    console.log(`✅ [EMAIL] Email enviado exitosamente a: ${to}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ [EMAIL] Error enviando email:', error);
    throw error;
  }
};

// Templates de emails
const emailTemplates = {
  // ========================================
  // TEMPLATES EXISTENTES (Facturas, PQRS)
  // ========================================

  invoiceIssued: (user, invoice) => ({
    subject: `Factura #${invoice.invoice_number} emitida`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Se ha emitido tu factura correspondiente al periodo ${invoice.period_month}/${invoice.period_year}.</p>
      <p><strong>Número de factura:</strong> ${invoice.invoice_number}</p>
      <p><strong>Monto total:</strong> $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}</p>
      <p><strong>Fecha de vencimiento:</strong> ${new Date(invoice.due_date).toLocaleDateString('es-CO')}</p>
      <p>Por favor realiza el pago antes de la fecha de vencimiento para evitar cargos adicionales.</p>
      <hr>
      <p><small>Sistema de Tarificación Acueductos</small></p>
    `,
    text: `Hola ${user.first_name}, se ha emitido tu factura #${invoice.invoice_number} por un monto de $${invoice.total_amount}. Fecha de vencimiento: ${invoice.due_date}.`,
  }),

  paymentReminder: (user, invoice, daysUntilDue) => ({
    subject: `Recordatorio: Factura #${invoice.invoice_number} vence en ${daysUntilDue} días`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Te recordamos que tu factura #${invoice.invoice_number} vence en <strong>${daysUntilDue} días</strong>.</p>
      <p><strong>Monto pendiente:</strong> $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}</p>
      <p><strong>Fecha de vencimiento:</strong> ${new Date(invoice.due_date).toLocaleDateString('es-CO')}</p>
      <p>Por favor realiza el pago lo antes posible para evitar recargos por mora.</p>
      <hr>
      <p><small>Sistema de Tarificación Acueductos</small></p>
    `,
    text: `Hola ${user.first_name}, tu factura #${invoice.invoice_number} vence en ${daysUntilDue} días. Monto: $${invoice.total_amount}.`,
  }),

  overdueAlert: (user, invoice) => ({
    subject: `⚠️ Factura #${invoice.invoice_number} vencida`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p><strong>Tu factura #${invoice.invoice_number} ha vencido.</strong></p>
      <p><strong>Monto pendiente:</strong> $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}</p>
      <p><strong>Fecha de vencimiento:</strong> ${new Date(invoice.due_date).toLocaleDateString('es-CO')}</p>
      <p>Por favor realiza el pago lo antes posible. Se aplicarán recargos por mora según la normativa vigente.</p>
      <p>Si ya realizaste el pago, por favor ignora este mensaje.</p>
      <hr>
      <p><small>Sistema de Tarificación Acueductos</small></p>
    `,
    text: `Hola ${user.first_name}, tu factura #${invoice.invoice_number} está vencida. Monto: $${invoice.total_amount}. Por favor realiza el pago lo antes posible.`,
  }),

  paymentConfirmed: (user, payment, invoice) => ({
    subject: `✅ Pago confirmado - Factura #${invoice.invoice_number}`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>¡Tu pago ha sido confirmado exitosamente!</p>
      <p><strong>Factura:</strong> #${invoice.invoice_number}</p>
      <p><strong>Monto pagado:</strong> $${parseFloat(payment.amount).toLocaleString('es-CO')}</p>
      <p><strong>Método de pago:</strong> ${payment.payment_method}</p>
      <p><strong>Fecha de pago:</strong> ${new Date(payment.payment_date).toLocaleDateString('es-CO')}</p>
      <p>Gracias por tu pago puntual.</p>
      <hr>
      <p><small>Sistema de Tarificación Acueductos</small></p>
    `,
    text: `Hola ${user.first_name}, tu pago de $${payment.amount} para la factura #${invoice.invoice_number} ha sido confirmado.`,
  }),

  pqrsUpdate: (user, pqrs) => ({
    subject: `Actualización PQRS #${pqrs.ticket_number}`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Tu ticket PQRS #${pqrs.ticket_number} ha sido actualizado.</p>
      <p><strong>Estado actual:</strong> ${pqrs.status}</p>
      <p><strong>Asunto:</strong> ${pqrs.subject}</p>
      <p>Puedes revisar el detalle y los comentarios en el sistema.</p>
      <hr>
      <p><small>Sistema de Tarificación Acueductos</small></p>
    `,
    text: `Hola ${user.first_name}, tu ticket PQRS #${pqrs.ticket_number} ha sido actualizado. Estado: ${pqrs.status}.`,
  }),

  pqrsCreated: (user, pqrs) => ({
    subject: `PQRS #${pqrs.ticket_number} creada`,
    html: `
      <h2>Hola ${user.first_name},</h2>
      <p>Tu solicitud PQRS ha sido creada exitosamente.</p>
      <p><strong>Ticket:</strong> #${pqrs.ticket_number}</p>
      <p><strong>Tipo:</strong> ${pqrs.type}</p>
      <p><strong>Asunto:</strong> ${pqrs.subject}</p>
      <p><strong>Estado:</strong> ${pqrs.status}</p>
      <p>Estaremos trabajando en tu solicitud y te mantendremos informado.</p>
      <hr>
      <p><small>Sistema de Tarificación Acueductos</small></p>
    `,
    text: `Hola ${user.first_name}, tu PQRS #${pqrs.ticket_number} ha sido creada. Tipo: ${pqrs.type}. Estado: ${pqrs.status}.`,
  }),

  // ========================================
  // NUEVOS TEMPLATES (Trial/Suscripciones)
  // ========================================

  trialExpiring: (tenant, days) => ({
    subject: `⏰ Tu período de prueba vence en ${days} ${days === 1 ? 'día' : 'días'}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; }
          .header { background: #3b82f6; color: white; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 30px 20px; background: #f9fafb; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb; }
          .content h2 { color: #1f2937; margin-top: 0; }
          .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; }
          .info-box { background: #ffffff; border: 1px solid #e5e7eb; padding: 15px; margin: 20px 0; border-radius: 6px; }
          .info-box p { margin: 8px 0; }
          .info-box strong { color: #1f2937; }
          .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white !important; text-decoration: none; border-radius: 6px; margin: 20px 0; font-weight: 600; }
          .button:hover { background: #2563eb; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; background: #f9fafb; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>⏰ Tu período de prueba está por vencer</h1>
          </div>
          <div class="content">
            <h2>Hola ${tenant.company_name},</h2>
            
            <div class="alert-box">
              <strong>⚠️ Atención:</strong> Tu período de prueba vence en <strong>${days} ${days === 1 ? 'día' : 'días'}</strong>.
            </div>
            
            <p>Para continuar usando nuestro servicio sin interrupciones, por favor actualiza tu plan antes de la fecha de vencimiento.</p>
            
            <div class="info-box">
              <p><strong>Empresa:</strong> ${tenant.company_name}</p>
              <p><strong>Plan actual:</strong> ${tenant.plan.toUpperCase()}</p>
              <p><strong>Fecha de vencimiento:</strong> ${new Date(
                tenant.trial_ends_at
              ).toLocaleDateString('es-ES', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              })}</p>
            </div>
            
            <p><strong>¿Qué pasará si no actualizo?</strong></p>
            <ul>
              <li>Tu cuenta será suspendida temporalmente</li>
              <li>No podrás acceder al sistema</li>
              <li>Tus datos se mantendrán seguros por 30 días</li>
            </ul>
            
            <p style="text-align: center;">
              <a href="#" class="button">Actualizar Plan Ahora</a>
            </p>
            
            <p>Si tienes alguna pregunta o necesitas ayuda, no dudes en contactarnos. Estamos aquí para ayudarte.</p>
          </div>
          <div class="footer">
            <p><strong>Equipo de Acueductos SaaS</strong></p>
            <p>© ${new Date().getFullYear()} Todos los derechos reservados</p>
            <p style="font-size: 12px; margin-top: 10px;">
              Este es un correo automático, por favor no respondas a este mensaje.
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Hola ${tenant.company_name}, tu período de prueba vence en ${days} días. Fecha de vencimiento: ${new Date(tenant.trial_ends_at).toLocaleDateString('es-ES')}. Por favor actualiza tu plan para continuar usando el servicio.`,
  }),

  trialExpired: (tenant) => ({
    subject: '🔒 Tu período de prueba ha finalizado',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; }
          .header { background: #ef4444; color: white; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 24px; }
          .content { padding: 30px 20px; background: #f9fafb; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb; }
          .content h2 { color: #1f2937; margin-top: 0; }
          .alert-box { background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; }
          .info-box { background: #ffffff; border: 1px solid #e5e7eb; padding: 15px; margin: 20px 0; border-radius: 6px; }
          .button { display: inline-block; padding: 14px 28px; background: #3b82f6; color: white !important; text-decoration: none; border-radius: 6px; margin: 20px 0; font-weight: 600; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; background: #f9fafb; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔒 Tu período de prueba ha finalizado</h1>
          </div>
          <div class="content">
            <h2>Hola ${tenant.company_name},</h2>
            
            <div class="alert-box">
              <strong>Tu período de prueba finalizó el ${new Date(tenant.trial_ends_at).toLocaleDateString('es-ES')}.</strong>
            </div>
            
            <p>Tu cuenta ha sido <strong>suspendida temporalmente</strong>. No te preocupes, todos tus datos están seguros.</p>
            
            <div class="info-box">
              <p><strong>¿Qué significa esto?</strong></p>
              <ul>
                <li>Tu acceso al sistema ha sido deshabilitado</li>
                <li>Tus datos permanecen seguros por 30 días</li>
                <li>Puedes reactivar tu cuenta en cualquier momento</li>
              </ul>
            </div>
            
            <p><strong>¿Cómo reactivar mi cuenta?</strong></p>
            <p>Simplemente selecciona un plan que se ajuste a tus necesidades y tu cuenta será reactivada inmediatamente.</p>
            
            <p style="text-align: center;">
              <a href="#" class="button">Seleccionar Plan</a>
            </p>
            
            <p>Si necesitas ayuda para elegir el plan adecuado o tienes alguna pregunta, nuestro equipo está aquí para ayudarte.</p>
            
            <p><strong>Contacto:</strong><br>
            Email: soporte@acueductos-saas.com<br>
            Teléfono: +57 300 123 4567</p>
          </div>
          <div class="footer">
            <p><strong>Equipo de Acueductos SaaS</strong></p>
            <p>© ${new Date().getFullYear()} Todos los derechos reservados</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Hola ${tenant.company_name}, tu período de prueba ha finalizado el ${new Date(tenant.trial_ends_at).toLocaleDateString('es-ES')}. Tu cuenta ha sido suspendida temporalmente. Para reactivarla, por favor selecciona un plan.`,
  }),

  trialExtended: (tenant, days) => ({
    subject: '✅ Tu período de prueba ha sido extendido',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #ffffff; }
          .header { background: #10b981; color: white; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { padding: 30px 20px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none; }
          .success-box { background: #d1fae5; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0; }
          .info-box { background: #ffffff; border: 1px solid #e5e7eb; padding: 15px; margin: 20px 0; border-radius: 6px; }
          .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 14px; background: #f9fafb; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>✅ ¡Buenas noticias!</h1>
          </div>
          <div class="content">
            <h2>Hola ${tenant.company_name},</h2>
            
            <div class="success-box">
              Tu período de prueba ha sido extendido por <strong>${days} días</strong>.
            </div>
            
            <p>Ahora tienes más tiempo para explorar todas las funcionalidades de nuestro sistema.</p>
            
            <div class="info-box">
              <p><strong>Nueva fecha de vencimiento:</strong><br>
              ${new Date(tenant.trial_ends_at).toLocaleDateString('es-ES', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
              })}</p>
            </div>
            
            <p>Aprovecha este tiempo para:</p>
            <ul>
              <li>Explorar todas las funcionalidades</li>
              <li>Configurar tu sistema</li>
              <li>Capacitar a tu equipo</li>
              <li>Evaluar el plan que mejor se ajusta a tus necesidades</li>
            </ul>
            
            <p>Si tienes alguna pregunta, estamos aquí para ayudarte.</p>
          </div>
          <div class="footer">
            <p><strong>Equipo de Acueductos SaaS</strong></p>
            <p>© ${new Date().getFullYear()} Todos los derechos reservados</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Hola ${tenant.company_name}, tu período de prueba ha sido extendido por ${days} días. Nueva fecha de vencimiento: ${new Date(tenant.trial_ends_at).toLocaleDateString('es-ES')}.`,
  }),
};

// ========================================
// ✅ FUNCIONES ESPECÍFICAS CORREGIDAS
// ========================================

/**
 * Enviar email de factura emitida
 * ✅ CORREGIDO: Acepta (tenantId, invoice) y extrae el cliente
 */
const sendInvoiceEmail = async (tenantId, invoice) => {
  try {
    // Extraer cliente (puede estar como 'client' o 'user')
    const user = invoice.client || invoice.user;

    if (!user || !user.email) {
      console.log('⚠️ [EMAIL] Usuario sin email, omitiendo envío');
      return { success: false, reason: 'no_email' };
    }

    console.log(`📧 [EMAIL] Enviando factura a: ${user.email}`);

    const template = emailTemplates.invoiceIssued(user, invoice);

    return await sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    console.error('❌ [EMAIL] Error en sendInvoiceEmail:', error);
    throw error;
  }
};

/**
 * Enviar email de pago confirmado
 * ✅ CORREGIDO
 */
const sendPaymentEmail = async (tenantId, payment) => {
  try {
    // Extraer user del payment o de la factura asociada
    const user =
      payment.user || payment.invoice?.client || payment.invoice?.user;
    const invoice = payment.invoice;

    if (!user || !user.email) {
      console.log('⚠️ [EMAIL] Usuario sin email, omitiendo envío');
      return { success: false, reason: 'no_email' };
    }

    if (!invoice) {
      console.log('⚠️ [EMAIL] Pago sin factura asociada');
      return { success: false, reason: 'no_invoice' };
    }

    console.log(`📧 [EMAIL] Enviando confirmación de pago a: ${user.email}`);

    const template = emailTemplates.paymentConfirmed(user, payment, invoice);

    return await sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    console.error('❌ [EMAIL] Error en sendPaymentEmail:', error);
    throw error;
  }
};

/**
 * Enviar email de recordatorio de pago
 * ✅ CORREGIDO
 */
const sendPaymentReminderEmail = async (
  tenantId,
  invoice,
  daysUntilDue = 7
) => {
  try {
    const user = invoice.client || invoice.user;

    if (!user || !user.email) {
      console.log('⚠️ [EMAIL] Usuario sin email, omitiendo envío');
      return { success: false, reason: 'no_email' };
    }

    console.log(`📧 [EMAIL] Enviando recordatorio de pago a: ${user.email}`);

    const template = emailTemplates.paymentReminder(
      user,
      invoice,
      daysUntilDue
    );

    return await sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    console.error('❌ [EMAIL] Error en sendPaymentReminderEmail:', error);
    throw error;
  }
};

/**
 * Enviar email de factura vencida
 * ✅ CORREGIDO
 */
const sendOverdueEmail = async (tenantId, invoice) => {
  try {
    const user = invoice.client || invoice.user;

    if (!user || !user.email) {
      console.log('⚠️ [EMAIL] Usuario sin email, omitiendo envío');
      return { success: false, reason: 'no_email' };
    }

    console.log(`📧 [EMAIL] Enviando alerta de vencimiento a: ${user.email}`);

    const template = emailTemplates.overdueAlert(user, invoice);

    return await sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    console.error('❌ [EMAIL] Error en sendOverdueEmail:', error);
    throw error;
  }
};

/**
 * Enviar email de actualización de PQRS
 * ✅ CORREGIDO
 */
const sendPQRSEmail = async (tenantId, pqrs) => {
  try {
    const user = pqrs.user || pqrs.client;

    if (!user || !user.email) {
      console.log('⚠️ [EMAIL] Usuario sin email, omitiendo envío');
      return { success: false, reason: 'no_email' };
    }

    console.log(`📧 [EMAIL] Enviando actualización de PQRS a: ${user.email}`);

    const template = emailTemplates.pqrsUpdate(user, pqrs);

    return await sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    console.error('❌ [EMAIL] Error en sendPQRSEmail:', error);
    throw error;
  }
};

/**
 * ✅ FUNCIÓN ADICIONAL: Enviar email de recordatorio de factura
 */
const sendInvoiceReminderEmail = async (
  tenantId,
  invoice,
  daysUntilDue = 7
) => {
  // Reutilizar sendPaymentReminderEmail (es lo mismo)
  return await sendPaymentReminderEmail(tenantId, invoice, daysUntilDue);
};

/**
 * ✅ FUNCIÓN ADICIONAL: Enviar email de confirmación de pago
 */
const sendPaymentConfirmationEmail = async (tenantId, payment) => {
  // Reutilizar sendPaymentEmail (es lo mismo)
  return await sendPaymentEmail(tenantId, payment);
};

/**
 * ✅ FUNCIÓN ADICIONAL: Enviar email de PQRS creada
 */
const sendPQRSCreatedEmail = async (tenantId, pqrs) => {
  try {
    const user = pqrs.user || pqrs.client;

    if (!user || !user.email) {
      console.log('⚠️ [EMAIL] Usuario sin email, omitiendo envío');
      return { success: false, reason: 'no_email' };
    }

    console.log(
      `📧 [EMAIL] Enviando confirmación de PQRS creada a: ${user.email}`
    );

    const template = emailTemplates.pqrsCreated(user, pqrs);

    return await sendEmail({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  } catch (error) {
    console.error('❌ [EMAIL] Error en sendPQRSCreatedEmail:', error);
    throw error;
  }
};

/**
 * ✅ FUNCIÓN ADICIONAL: Enviar email de PQRS actualizada
 */
const sendPQRSUpdatedEmail = async (tenantId, pqrs) => {
  // Reutilizar sendPQRSEmail (es lo mismo)
  return await sendPQRSEmail(tenantId, pqrs);
};

module.exports = {
  sendEmail,
  verifyEmailConfig,
  emailTemplates,
  // ✅ Funciones corregidas y completas:
  sendInvoiceEmail,
  sendPaymentEmail,
  sendPaymentReminderEmail,
  sendOverdueEmail,
  sendPQRSEmail,
  // ✅ Funciones adicionales:
  sendInvoiceReminderEmail,
  sendPaymentConfirmationEmail,
  sendPQRSCreatedEmail,
  sendPQRSUpdatedEmail,
};
