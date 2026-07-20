// backend/src/controllers/ncfWebhook.controller.js
// Recibe los eventos que el Núcleo dispara hacia Pitbox: prefactura.rejected,
// prefactura.payment_link_generated, prefactura.paid, invoice.issued,
// prefactura.expired, invoice.error. Ver webhookDispatcher.js del lado del
// Núcleo para el shape exacto de cada payload.
//
// El tenant se ubica por `ncf_external_ref` (el mismo que ncfSyncService
// generó y envió como external_ref de la prefactura) -- todo el estado
// vive en las columnas ncf_* de `tenants`, no en una tabla aparte. Si no
// se encuentra el tenant, no se falla el webhook -- se responde 200 igual
// para que el Núcleo no reintente indefinidamente algo que nunca va a
// encontrar (ej. ambiente de pruebas distinto).
const Tenant = require('../models/Tenant');
const TenantSubscription = require('../models/subscriptions/TenantSubscription');
const ncfClient = require('../services/ncf/ncfClient');
const emailService = require('../services/emailService');
const { calcularProximoCiclo } = require('../services/ncf/ncfSyncService');
const logger = require('../config/logger');

async function handleWebhook(req, res) {
  const signature = req.headers['x-ncf-signature'];
  const rawBody = req.rawBody; // ver ncfWebhook.routes.js -- se captura crudo antes de parsear

  const valid = await ncfClient.verificarFirmaWebhook(rawBody, signature);
  if (!valid) {
    logger.warn('[NCF Webhook] Firma inválida, se ignora la notificación');
    return res.status(200).json({ received: true, ignored: true });
  }

  const eventType = req.headers['x-ncf-event'];
  const payload = req.body;
  const externalRef = payload?.external_ref;

  logger.info(`[NCF Webhook] ${eventType} -- external_ref=${externalRef}`);

  const tenant = externalRef
    ? await Tenant.findOne({ where: { ncf_external_ref: externalRef } })
    : null;

  if (!tenant) {
    logger.warn(`[NCF Webhook] No se encontró tenant con ncf_external_ref=${externalRef} -- se ignora`);
    return res.status(200).json({ received: true, matched: false });
  }

  switch (eventType) {
    case 'prefactura.payment_link_generated':
      await tenant.update({ ncf_last_status: 'payment_link_generated', ncf_payment_link_url: payload.payment_link_url, ncf_last_error: null });
      emailService.sendSubscriptionPaymentLinkEmail(tenant.id, {
        total: payload.total,
        moneda: payload.moneda,
        fecha_limite_pago: payload.fecha_limite_pago,
        payment_link_url: payload.payment_link_url,
      }).catch((e) => logger.error(`[NCF Webhook] Error notificando link de pago: ${e.message}`));
      break;

    case 'prefactura.paid': {
      const estabaSuspendido = tenant.subscription_status === 'suspended';
      await tenant.update({ ncf_last_status: 'paid', ncf_last_error: null, subscription_status: 'active' });

      // Avanzar al siguiente ciclo -- si no se hace esto, la próxima
      // sincronización ve el mismo ciclo "ya sincronizado" para siempre y
      // el tenant nunca se vuelve a facturar.
      const sub = await TenantSubscription.findOne({
        where: { tenant_id: tenant.id, status: { [require('sequelize').Op.in]: ['active', 'past_due', 'suspended'] } },
        order: [['created_at', 'DESC']],
      });
      if (sub) {
        const proximoCiclo = calcularProximoCiclo(sub.next_billing_date, sub.billing_cycle);
        await sub.update({
          status: 'active',
          current_period_start: sub.next_billing_date,
          current_period_end: proximoCiclo,
          next_billing_date: proximoCiclo,
        });
      }

      if (estabaSuspendido) {
        logger.info(`[NCF Webhook] Tenant ${tenant.id} reactivado automáticamente tras confirmar el pago`);
        emailService.sendSubscriptionReactivatedEmail(tenant.id, {}).catch((e) => logger.error(`[NCF Webhook] Error notificando reactivación: ${e.message}`));
      }
      break;
    }

    case 'invoice.issued':
      await tenant.update({
        ncf_last_status: 'invoiced',
        ncf_last_error: null,
      });
      logger.info(`[NCF Webhook] Factura emitida para tenant ${tenant.id}: ${payload.full_invoice_number} (CUFE ${payload.cufe})`);
      emailService.sendSubscriptionInvoiceIssuedEmail(tenant.id, {
        full_invoice_number: payload.full_invoice_number,
        cufe: payload.cufe,
        pdf_url: payload.pdf_url,
      }).catch((e) => logger.error(`[NCF Webhook] Error notificando factura emitida: ${e.message}`));
      break;

    case 'prefactura.rejected':
      await tenant.update({ ncf_last_status: 'rejected', ncf_last_error: payload.reason || 'Datos fiscales incompletos' });
      break;

    case 'prefactura.expired':
      // OJO: Tenant.subscription_status solo admite trial/active/suspended/
      // cancelled (ver models/auth/Tenant.js) -- 'past_due' NO es válido
      // ahí, solo en TenantSubscription.status. El tenant sigue con acceso
      // normal durante la gracia; se bloquea de verdad recién cuando
      // revisarSuspensiones() lo marca 'suspended' (ver ncfSyncService.js).
      await tenant.update({ ncf_last_status: 'expired', ncf_last_error: 'Venció el plazo de pago sin confirmarse' });
      await TenantSubscription.update(
        { status: 'past_due' },
        { where: { tenant_id: tenant.id, status: 'active' } }
      );
      break;

    case 'invoice.error':
      await tenant.update({ ncf_last_status: 'error', ncf_last_error: payload.error });
      break;

    default:
      logger.warn(`[NCF Webhook] Tipo de evento desconocido: ${eventType}`);
  }

  res.status(200).json({ received: true, matched: true });
}

module.exports = { handleWebhook };
