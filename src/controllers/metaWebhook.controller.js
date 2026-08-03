// backend/src/controllers/metaWebhook.controller.js
// Recibe los eventos de Meta (Facebook/Instagram) -- hoy solo `leadgen`
// (Lead Ads). Mismo espíritu que ncfWebhook.controller.js: ruta pública,
// se autentica por firma HMAC en vez de JWT, y siempre responde 200 para
// que Meta no reintente indefinidamente algo que ya se resolvió (o que
// nunca va a encontrar, ej. un tenant que se dio de baja).
//
// Un webhook de Meta llega SIN contexto de tenant -- a diferencia de una
// request normal de la app, todavía no sabemos a qué tenant pertenece.
// Por eso la resolución (ver resolverTenantConfig) consulta TenantMetaConfig
// en `public` ANTES de fijar cualquier schema (ver nota en el modelo).
const { Op } = require('sequelize');
const logger = require('../config/logger') || console;
const { TenantMetaConfig, Tenant } = require('../models');
const metaClient = require('../services/meta/metaClient');
const { runWithTenantSchema } = require('../config/tenantContext');
const { getEffectiveModulesForTenantId } = require('../services/moduleAccess');
const { applyOpportunityCreatedRules } = require('../services/crmAutomationEngine');

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

/**
 * Encuentra a qué TenantMetaConfig pertenece un evento, por page_id (modo
 * "own") o por form_id (modo "pitbox", asignado a mano al onboardear).
 */
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

  // El tenant pudo haber conectado Meta y luego perder el módulo (plan
  // bajado, módulo desactivado a mano) -- no seguir creando oportunidades
  // gratis para alguien que ya no lo tiene contratado.
  const effectiveModules = await getEffectiveModulesForTenantId(tenant.id);
  if (!effectiveModules.includes('crm_meta_leads')) {
    logger.warn(`[Meta Webhook] Tenant ${tenant.id} ya no tiene el módulo crm_meta_leads activo -- se ignora el lead`);
    return;
  }

  const isOwn = tenantConfig.provider_mode === 'own';
  let accessToken = tenantConfig.own_access_token;
  if (!isOwn) {
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

    // Fase C.1 — ej. "lead de Meta Ads entra → asignar por ronda entre
    // asesores activos". Corre dentro del mismo `run` (ya en el schema del
    // tenant) para que la regla vea las tablas correctas.
    await applyOpportunityCreatedRules(tenant.id, opportunity);

    return { customerId: customer.id, opportunityId: opportunity.id };
  };

  const result = tenant.schema_name ? await runWithTenantSchema(tenant.schema_name, run) : await run();

  await tenantConfig.update({ last_lead_at: new Date(), last_error: null });
  logger.info(`[Meta Webhook] Lead ${leadgenId} -> tenant ${tenant.id}: customer ${result.customerId}, opportunity ${result.opportunityId}`);
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

  if (payload?.object !== 'page') {
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
