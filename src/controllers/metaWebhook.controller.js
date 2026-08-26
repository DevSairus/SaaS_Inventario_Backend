// backend/src/controllers/metaWebhook.controller.js
// Webhooks Meta: Lead Ads (`page` / leadgen) + WhatsApp Cloud API
// (`whatsapp_business_account` / messages, statuses, smb_message_echoes).
const { Op } = require('sequelize');
const logger = require('../config/logger') || console;
const { TenantMetaConfig, Tenant } = require('../models');
const metaClient = require('../services/meta/metaClient');
const waCloud = require('../services/whatsappCloud.service');
const { runWithTenantSchema } = require('../config/tenantContext');
const { getEffectiveModulesForTenantId } = require('../services/moduleAccess');
const { applyOpportunityCreatedRules } = require('../services/crmAutomationEngine');
const { decryptToken } = require('../utils/metaTokenCrypto');

async function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const result = await metaClient.verificarHandshake({ mode, verifyToken, challenge });
  if (result === null) {
    logger.warn('[Meta Webhook] Handshake de verificación fallido (verify_token no coincide)');
    return res.status(403).send('Forbidden');
  }
  return res.status(200).send(result);
}

async function resolverTenantConfig({ pageId, formId }) {
  if (pageId) {
    const own = await TenantMetaConfig.findOne({
      where: { provider_mode: 'own', own_page_id: pageId, is_active: true },
    });
    if (own) return own;
  }
  if (formId) {
    const shared = await TenantMetaConfig.findOne({
      where: { provider_mode: 'pitbox', is_active: true, pitbox_lead_form_ids: { [Op.contains]: [formId] } },
    });
    if (shared) return shared;
  }
  return null;
}

async function procesarLead({ leadgenId, formId, tenantConfig }) {
  const tenant = await Tenant.findByPk(tenantConfig.tenant_id);
  if (!tenant) {
    logger.warn(`[Meta Webhook] TenantMetaConfig ${tenantConfig.id} apunta a un tenant inexistente`);
    return;
  }

  const effectiveModules = await getEffectiveModulesForTenantId(tenant.id);
  if (!effectiveModules.includes('crm_meta_leads')) {
    logger.warn(`[Meta Webhook] Tenant ${tenant.id} ya no tiene el módulo crm_meta_leads activo -- se ignora el lead`);
    return;
  }

  const isOwn = tenantConfig.provider_mode === 'own';
  let accessToken = null;
  if (isOwn) {
    try {
      accessToken = decryptToken(tenantConfig.own_access_token);
    } catch (_) {
      accessToken = tenantConfig.own_access_token;
    }
  } else {
    const metaConfig = await metaClient.getConfig();
    accessToken = metaConfig?.shared_system_user_token;
  }
  if (!accessToken) {
    logger.error(`[Meta Webhook] Sin access_token disponible para tenant ${tenant.id} (modo ${tenantConfig.provider_mode})`);
    await tenantConfig.update({ last_error: 'Sin access_token disponible para leer el lead' });
    return;
  }

  const lead = await metaClient.getLeadDetails(leadgenId, accessToken);
  const fields = {};
  (lead.field_data || []).forEach((f) => { fields[f.name] = (f.values || [])[0]; });

  const fullName = fields.full_name || `${fields.first_name || ''} ${fields.last_name || ''}`.trim() || 'Lead de Facebook/Instagram';
  const email = fields.email || null;
  const phone = fields.phone_number || fields.phone || null;

  const run = async () => {
    const { Customer, Opportunity, CustomerInteraction } = require('../models');

    let customer = null;
    if (phone) customer = await Customer.findOne({ where: { tenant_id: tenant.id, phone } });
    if (!customer && email) customer = await Customer.findOne({ where: { tenant_id: tenant.id, email } });

    if (!customer) {
      const parts = fullName.split(/\s+/);
      customer = await Customer.create({
        tenant_id: tenant.id,
        first_name: parts[0] || 'Lead',
        last_name: parts.slice(1).join(' ') || '',
        email,
        phone,
        customer_type: 'individual',
        is_active: true,
      });
    }

    const opportunity = await Opportunity.create({
      tenant_id: tenant.id,
      branch_id: null,
      customer_id: customer.id,
      owner_user_id: null,
      source: 'meta_ads',
      stage: 'nuevo',
      stage_changed_at: new Date(),
    });

    await CustomerInteraction.create({
      tenant_id: tenant.id,
      customer_id: customer.id,
      user_id: null,
      type: 'nota',
      channel_ref: leadgenId,
      summary: `Lead recibido desde Meta (form ${formId}) -- ${JSON.stringify(fields)}`,
      outcome: 'sin_respuesta',
    });

    await applyOpportunityCreatedRules(tenant.id, opportunity);

    return { customerId: customer.id, opportunityId: opportunity.id };
  };

  const result = tenant.schema_name ? await runWithTenantSchema(tenant.schema_name, run) : await run();

  await tenantConfig.update({ last_lead_at: new Date(), last_error: null });
  logger.info(`[Meta Webhook] Lead ${leadgenId} -> tenant ${tenant.id}: customer ${result.customerId}, opportunity ${result.opportunityId}`);
}

async function procesarWhatsAppEntry(entry) {
  const changes = entry.changes || [];
  for (const change of changes) {
    const value = change.value || {};
    const field = change.field;
    const metadata = value.metadata || {};
    const phoneNumberId = metadata.phone_number_id;

    if (field === 'messages' || !field) {
      const contacts = value.contacts || [];
      const contactName = contacts[0]?.profile?.name || null;

      for (const message of value.messages || []) {
        try {
          await waCloud.ingestInboundWhatsApp({
            phoneNumberId,
            contactPhone: message.from,
            contactName,
            message,
            source: 'webhook',
          });
        } catch (err) {
          logger.error(`[Meta WA] Error inbound ${message.id}: ${err.message}`);
        }
      }

      // tenantId resuelto UNA vez por phone_number_id (no por cada status)
      // -- antes updateMessageStatus se llamaba sin tenantId, así que el
      // dato en BD quedaba bien pero el evento socket `wa:message-status`
      // nunca se emitía (ver el `if (tenantId)` adentro de esa función):
      // el inbox no mostraba los ticks de enviado/entregado/leído en vivo,
      // solo al recargar. Con esto los updates llegan en tiempo real.
      if (value.statuses?.length) {
        const tenantConfig = await waCloud.resolverTenantByPhoneNumberId(phoneNumberId);
        for (const status of value.statuses) {
          try {
            await waCloud.updateMessageStatus({
              metaMessageId: status.id,
              status: status.status,
              tenantId: tenantConfig?.tenant_id || null,
            });
          } catch (err) {
            logger.error(`[Meta WA] Error status ${status.id}: ${err.message}`);
          }
        }
      }
    }

    // Coexistencia: mensajes enviados desde WhatsApp Business App
    if (field === 'smb_message_echoes' || value.message_echoes) {
      const echoes = value.message_echoes || value.messages || [];
      for (const echo of echoes) {
        try {
          await waCloud.ingestInboundWhatsApp({
            phoneNumberId,
            contactPhone: echo.to || echo.recipient_id,
            contactName: null,
            message: { ...echo, from: echo.to, id: echo.id },
            source: 'app_echo',
          });
        } catch (err) {
          logger.error(`[Meta WA] Error echo ${echo.id}: ${err.message}`);
        }
      }
    }
  }
}

async function handleWebhook(req, res) {
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = req.rawBody;
  const payload = req.body;

  // Un tenant en modo "own" con App propia firma sus webhooks con SU
  // app_secret, no con el de Pitbox -- hay que resolver cuál usar según la
  // página del primer entry ANTES de verificar (ver resolveAppSecretForPage).
  // Todo un mismo request viene de una sola App, así que alcanza con el
  // primer entry para elegir el secret candidato.
  const firstPageId = payload?.entry?.[0]?.id;
  const { appSecret } = await metaClient.resolveAppSecretForPage(firstPageId);

  const valid = await metaClient.verificarFirmaWebhook(rawBody, signature, appSecret);
  if (!valid) {
    logger.warn('[Meta Webhook] Firma inválida, se ignora la notificación');
    return res.status(200).json({ received: true, ignored: true });
  }

  const objectType = payload?.object;

  // WhatsApp Cloud API
  if (objectType === 'whatsapp_business_account') {
    for (const entry of payload.entry || []) {
      try {
        await procesarWhatsAppEntry(entry);
      } catch (err) {
        logger.error(`[Meta WA] Error entry: ${err.message}`);
      }
    }
    return res.status(200).json({ received: true });
  }

  // Lead Ads (páginas)
  if (objectType !== 'page') {
    return res.status(200).json({ received: true, ignored: true });
  }

  for (const entry of payload.entry || []) {
    const pageId = entry.id;
    for (const change of entry.changes || []) {
      if (change.field !== 'leadgen') continue;
      const { leadgen_id: leadgenId, form_id: formId } = change.value || {};
      if (!leadgenId) continue;

      try {
        const tenantConfig = await resolverTenantConfig({ pageId, formId });
        if (!tenantConfig) {
          logger.warn(`[Meta Webhook] No se encontró tenant para page_id=${pageId} form_id=${formId} -- se ignora`);
          continue;
        }
        await procesarLead({ leadgenId, formId, tenantConfig });
      } catch (err) {
        logger.error(`[Meta Webhook] Error procesando lead ${leadgenId}: ${err.message}`);
      }
    }
  }

  res.status(200).json({ received: true });
}

module.exports = { handleVerify, handleWebhook };
