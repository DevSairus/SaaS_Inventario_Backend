/**
 * Servicio de SMS - Actualizado para Infobip
 * Mantiene compatibilidad con Twilio para migración gradual
 */

const { sendInfobipSMS } = require('../config/infobip');

/**
 * Enviar SMS usando el proveedor configurado
 */
const sendSMS = async (tenantId, options) => {
  try {
    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      throw new Error('Tenant no encontrado');
    }

    const config = tenant.business_config?.notifications || {};

    if (!config.sms_enabled) {
      console.log('⚠️ [SMS] SMS no habilitado para tenant:', tenantId);
      return {
        success: false,
        error: 'SMS no está habilitado',
      };
    }

    // Determinar proveedor (Infobip por defecto, Twilio para backward compatibility)
    const provider = config.sms_provider || 'infobip';

    console.log(`📱 [SMS] Usando proveedor: ${provider.toUpperCase()}`);

    if (provider === 'infobip') {
      return await sendInfobipSMS(tenantId, options);
    } else if (provider === 'twilio') {
      // Mantener compatibilidad con Twilio (legacy)
      return await sendTwilioSMS(tenantId, options);
    } else {
      throw new Error(`Proveedor de SMS no soportado: ${provider}`);
    }
  } catch (error) {
    console.error('❌ [SMS] Error enviando SMS:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

/**
 * Enviar SMS masivo
 */
const sendBulkSMS = async (tenantId, recipients) => {
  try {
    console.log(
      `📱 [SMS] Enviando SMS masivo a ${recipients.length} destinatarios`
    );

    const results = await Promise.allSettled(
      recipients.map((recipient) =>
        sendSMS(tenantId, {
          to: recipient.phone,
          message: recipient.message,
        })
      )
    );

    const successful = results.filter(
      (r) => r.status === 'fulfilled' && r.value.success
    ).length;
    const failed = results.length - successful;

    console.log(
      `✅ [SMS] Masivo completado: ${successful} éxitos, ${failed} fallos`
    );

    return {
      success: true,
      total: recipients.length,
      successful,
      failed,
      results,
    };
  } catch (error) {
    console.error('❌ [SMS] Error en envío masivo:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

// ========================================
// ✅ FUNCIONES ESPECÍFICAS CORREGIDAS
// ========================================

/**
 * Enviar SMS de recordatorio de factura
 * ✅ CORREGIDO: Busca invoice.client primero, luego invoice.user
 */
const sendInvoiceReminderSMS = async (tenantId, invoice) => {
  try {
    // Extraer cliente (puede estar como 'client' o 'user')
    const user = invoice.client || invoice.user;

    if (!user || !user.phone) {
      console.log('⚠️ [SMS] Usuario sin teléfono');
      return { success: false, error: 'Usuario sin teléfono' };
    }

    const dueDate = new Date(invoice.due_date).toLocaleDateString('es-CO');
    const message = `Recordatorio: Tu factura ${invoice.invoice_number} por $${parseFloat(invoice.total_amount).toLocaleString('es-CO')} vence el ${dueDate}. Evita intereses de mora.`;

    console.log(`📱 [SMS] Enviando recordatorio de factura a: ${user.phone}`);

    return await sendSMS(tenantId, {
      to: user.phone,
      message,
    });
  } catch (error) {
    console.error('❌ [SMS] Error en recordatorio:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

/**
 * Enviar SMS de factura vencida
 * ✅ CORREGIDO
 */
const sendOverdueSMS = async (tenantId, invoice) => {
  try {
    const user = invoice.client || invoice.user;

    if (!user || !user.phone) {
      console.log('⚠️ [SMS] Usuario sin teléfono');
      return { success: false, error: 'Usuario sin teléfono' };
    }

    const daysOverdue = Math.floor(
      (new Date() - new Date(invoice.due_date)) / (1000 * 60 * 60 * 24)
    );

    const message = `URGENTE: Tu factura ${invoice.invoice_number} está vencida hace ${daysOverdue} días. Monto: $${parseFloat(invoice.total_amount).toLocaleString('es-CO')}. Paga ahora para evitar corte del servicio.`;

    console.log(`📱 [SMS] Enviando alerta de vencimiento a: ${user.phone}`);

    return await sendSMS(tenantId, {
      to: user.phone,
      message,
    });
  } catch (error) {
    console.error('❌ [SMS] Error en SMS vencido:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

/**
 * Enviar SMS de confirmación de pago
 * ✅ CORREGIDO
 */
const sendPaymentConfirmationSMS = async (tenantId, payment) => {
  try {
    // Extraer user del payment o de la factura asociada
    const user =
      payment.user || payment.invoice?.client || payment.invoice?.user;
    const invoice = payment.invoice;

    if (!user || !user.phone) {
      console.log('⚠️ [SMS] Usuario sin teléfono');
      return { success: false, error: 'Usuario sin teléfono' };
    }

    if (!invoice) {
      console.log('⚠️ [SMS] Pago sin factura asociada');
      return { success: false, error: 'Pago sin factura' };
    }

    const message = `Pago recibido! Monto: $${parseFloat(payment.amount).toLocaleString('es-CO')}. Referencia: ${payment.reference_number || invoice.invoice_number}. Gracias por tu pago.`;

    console.log(`📱 [SMS] Enviando confirmación de pago a: ${user.phone}`);

    return await sendSMS(tenantId, {
      to: user.phone,
      message,
    });
  } catch (error) {
    console.error('❌ [SMS] Error en confirmación de pago:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

/**
 * Enviar SMS de nuevo PQRS
 * ✅ CORREGIDO
 */
const sendPQRSCreatedSMS = async (tenantId, pqrs) => {
  try {
    const user = pqrs.user || pqrs.client;

    if (!user || !user.phone) {
      console.log('⚠️ [SMS] Usuario sin teléfono');
      return { success: false, error: 'Usuario sin teléfono' };
    }

    const message = `Tu ${pqrs.type} #${pqrs.ticket_number} ha sido recibida. Revisaremos tu solicitud pronto. Gracias.`;

    console.log(`📱 [SMS] Enviando confirmación de PQRS a: ${user.phone}`);

    return await sendSMS(tenantId, {
      to: user.phone,
      message,
    });
  } catch (error) {
    console.error('❌ [SMS] Error en SMS PQRS:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

/**
 * Enviar SMS de PQRS actualizada
 * ✅ CORREGIDO
 */
const sendPQRSUpdatedSMS = async (tenantId, pqrs) => {
  try {
    const user = pqrs.user || pqrs.client;

    if (!user || !user.phone) {
      console.log('⚠️ [SMS] Usuario sin teléfono');
      return { success: false, error: 'Usuario sin teléfono' };
    }

    const message = `Actualización de tu ${pqrs.type} #${pqrs.ticket_number}. Estado: ${pqrs.status}. Revisa los detalles en tu cuenta.`;

    console.log(`📱 [SMS] Enviando actualización de PQRS a: ${user.phone}`);

    return await sendSMS(tenantId, {
      to: user.phone,
      message,
    });
  } catch (error) {
    console.error('❌ [SMS] Error en SMS actualización PQRS:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

// ============================================
// LEGACY: Soporte para Twilio (backward compatibility)
// ============================================

/**
 * Enviar SMS usando Twilio (legacy)
 * @deprecated Usar Infobip en su lugar
 */
const sendTwilioSMS = async (tenantId, options) => {
  try {
    console.log('⚠️ [SMS] Usando Twilio (legacy mode)');

    const Tenant = require('../models/Tenant');
    const tenant = await Tenant.findByPk(tenantId);
    const config = tenant.business_config?.notifications || {};

    if (!config.twilio_account_sid || !config.twilio_auth_token) {
      throw new Error('Configuración de Twilio incompleta');
    }

    const twilio = require('twilio');
    const client = twilio(config.twilio_account_sid, config.twilio_auth_token);

    const result = await client.messages.create({
      body: options.message,
      from: config.twilio_phone_number,
      to: options.to,
    });

    console.log('✅ [TWILIO] SMS enviado:', result.sid);

    return {
      success: true,
      messageId: result.sid,
      status: result.status,
    };
  } catch (error) {
    console.error('❌ [TWILIO] Error:', error);
    return {
      success: false,
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    };
  }
};

module.exports = {
  sendSMS,
  sendBulkSMS,
  sendInvoiceReminderSMS,
  sendOverdueSMS,
  sendPaymentConfirmationSMS,
  sendPQRSCreatedSMS,
  sendPQRSUpdatedSMS,
  // Legacy
  sendTwilioSMS,
};
