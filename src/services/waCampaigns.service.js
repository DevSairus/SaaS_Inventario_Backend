// Plantillas Meta, recordatorios y campañas WhatsApp (Fase 3).
const { Op } = require('sequelize');
const logger = require('../config/logger') || console;
const metaClient = require('./meta/metaClient');
const waCloud = require('./whatsappCloud.service');
const { runWithTenantSchema } = require('../config/tenantContext');
const {
  Tenant,
  Customer,
  CustomerTagAssignment,
  WaTemplate,
  WaReminderJob,
  WaCampaign,
  WaCampaignRecipient,
} = require('../models');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function syncTemplatesForTenant(tenantId) {
  const config = await waCloud.getTenantWaConfig(tenantId);
  if (!config?.own_waba_id) {
    const err = new Error('WhatsApp no conectado');
    err.status = 400;
    throw err;
  }
  const token = await waCloud.resolveAccessToken(config);
  if (!token) {
    const err = new Error('Token no disponible');
    err.status = 400;
    throw err;
  }

  const tenant = await Tenant.findByPk(tenantId);
  const remote = await metaClient.listWabaMessageTemplates(config.own_waba_id, token);
  const now = new Date();

  const run = async () => {
    let upserted = 0;
    for (const t of remote) {
      const [row] = await WaTemplate.findOrCreate({
        where: {
          tenant_id: tenantId,
          name: t.name,
          language: t.language || 'es',
        },
        defaults: {
          tenant_id: tenantId,
          name: t.name,
          language: t.language || 'es',
          status: t.status || 'PENDING',
          category: t.category || null,
          components_schema: t.components || null,
          meta_template_id: t.id ? String(t.id) : null,
          last_synced_at: now,
        },
      });
      await row.update({
        status: t.status || row.status,
        category: t.category || row.category,
        components_schema: t.components || row.components_schema,
        meta_template_id: t.id ? String(t.id) : row.meta_template_id,
        last_synced_at: now,
      });
      upserted += 1;
    }
    return upserted;
  };

  const count = tenant?.schema_name
    ? await runWithTenantSchema(tenant.schema_name, run)
    : await run();

  return { synced: count, templates: remote.length };
}

async function listLocalTemplates(tenantId, { status } = {}) {
  const where = { tenant_id: tenantId };
  if (status) where.status = status;
  return WaTemplate.findAll({ where, order: [['name', 'ASC'], ['language', 'ASC']] });
}

async function createReminderJob({
  tenantId,
  customerId,
  phone,
  templateName,
  language = 'es',
  components = null,
  scheduledAt,
  userId = null,
}) {
  const clean = waCloud.normalizePhone(phone);
  if (!clean || !templateName || !scheduledAt) {
    const err = new Error('phone, template_name y scheduled_at son requeridos');
    err.status = 400;
    throw err;
  }
  return WaReminderJob.create({
    tenant_id: tenantId,
    customer_id: customerId || null,
    phone: clean,
    template_name: templateName,
    language,
    components,
    scheduled_at: new Date(scheduledAt),
    status: 'pending',
    created_by_user_id: userId,
  });
}

async function processDueReminders() {
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  let processed = 0;

  for (const tenant of tenants) {
    const run = async () => {
      const due = await WaReminderJob.findAll({
        where: {
          tenant_id: tenant.id,
          status: 'pending',
          scheduled_at: { [Op.lte]: new Date() },
        },
        order: [['scheduled_at', 'ASC']],
        limit: 20,
      });

      for (const job of due) {
        try {
          await waCloud.sendTemplateFromTenant({
            tenantId: tenant.id,
            to: job.phone,
            templateName: job.template_name,
            language: job.language,
            components: job.components || [],
            userId: job.created_by_user_id,
            source: 'automation',
          });
          await job.update({ status: 'sent', sent_at: new Date(), error_message: null });
          processed += 1;
        } catch (err) {
          await job.update({
            status: 'failed',
            error_message: (err.response?.data?.error?.message || err.message || '').slice(0, 500),
          });
        }
        await sleep(60); // ~16 mps max local; coexistencia tipicamente ~20 mps
      }
    };

    try {
      if (tenant.schema_name) await runWithTenantSchema(tenant.schema_name, run);
      else await run();
    } catch (err) {
      logger.warn(`[WA Reminders] tenant ${tenant.id}: ${err.message}`);
    }
  }

  return { processed };
}

async function resolveAudiencePhones(tenantId, audienceFilter = {}) {
  const where = { tenant_id: tenantId, is_active: true };
  const customers = await Customer.findAll({
    where,
    attributes: ['id', 'phone', 'mobile'],
    limit: 5000,
  });

  let list = customers;
  if (audienceFilter.tag_id) {
    const assigns = await CustomerTagAssignment.findAll({
      where: { customer_tag_id: audienceFilter.tag_id },
      attributes: ['customer_id'],
    });
    const ids = new Set(assigns.map((a) => a.customer_id));
    list = list.filter((c) => ids.has(c.id));
  }

  // Opt-out explícito por teléfono (lista negra en audience_filter.blocked_phones)
  const blocked = new Set(
    (audienceFilter.blocked_phones || []).map((p) => waCloud.normalizePhone(p))
  );

  const phones = [];
  const seen = new Set();
  for (const c of list) {
    const phone = waCloud.normalizePhone(c.mobile || c.phone);
    if (!phone || seen.has(phone) || blocked.has(phone)) continue;
    seen.add(phone);
    phones.push({ customer_id: c.id, phone });
  }
  return phones;
}

async function createCampaign({
  tenantId,
  name,
  templateName,
  language = 'es',
  audienceFilter = {},
  userId = null,
  start = false,
}) {
  if (!name || !templateName) {
    const err = new Error('name y template_name son requeridos');
    err.status = 400;
    throw err;
  }

  const recipients = await resolveAudiencePhones(tenantId, audienceFilter);
  const campaign = await WaCampaign.create({
    tenant_id: tenantId,
    name,
    template_name: templateName,
    language,
    status: start ? 'queued' : 'draft',
    audience_filter: audienceFilter,
    total_count: recipients.length,
    created_by_user_id: userId,
    started_at: start ? new Date() : null,
  });

  if (recipients.length) {
    await WaCampaignRecipient.bulkCreate(
      recipients.map((r) => ({
        tenant_id: tenantId,
        campaign_id: campaign.id,
        customer_id: r.customer_id,
        phone: r.phone,
        status: 'pending',
      }))
    );
  }

  return campaign;
}

async function startCampaign(tenantId, campaignId) {
  const campaign = await WaCampaign.findOne({ where: { id: campaignId, tenant_id: tenantId } });
  if (!campaign) {
    const err = new Error('Campaña no encontrada');
    err.status = 404;
    throw err;
  }
  if (!['draft', 'paused'].includes(campaign.status)) {
    const err = new Error('La campaña no se puede iniciar en este estado');
    err.status = 400;
    throw err;
  }
  await campaign.update({ status: 'queued', started_at: campaign.started_at || new Date() });
  return campaign;
}

async function processQueuedCampaigns() {
  const tenants = await Tenant.findAll({ where: { is_active: true }, attributes: ['id', 'schema_name'] });
  let sent = 0;

  for (const tenant of tenants) {
    const run = async () => {
      const campaigns = await WaCampaign.findAll({
        where: { tenant_id: tenant.id, status: { [Op.in]: ['queued', 'running'] } },
        limit: 3,
      });

      for (const campaign of campaigns) {
        if (campaign.status === 'queued') {
          await campaign.update({ status: 'running', started_at: campaign.started_at || new Date() });
        }

        const batch = await WaCampaignRecipient.findAll({
          where: { campaign_id: campaign.id, status: 'pending' },
          order: [['created_at', 'ASC']],
          limit: 15,
        });

        if (!batch.length) {
          await campaign.update({ status: 'completed', finished_at: new Date() });
          continue;
        }

        for (const recipient of batch) {
          try {
            const result = await waCloud.sendTemplateFromTenant({
              tenantId: tenant.id,
              to: recipient.phone,
              templateName: campaign.template_name,
              language: campaign.language,
              components: [],
              userId: campaign.created_by_user_id,
              source: 'broadcast',
            });
            await recipient.update({
              status: 'sent',
              sent_at: new Date(),
              meta_message_id: result.meta_message_id || null,
              error_message: null,
            });
            await campaign.increment('sent_count');
            sent += 1;
          } catch (err) {
            await recipient.update({
              status: 'failed',
              error_message: (err.response?.data?.error?.message || err.message || '').slice(0, 500),
            });
            await campaign.increment('failed_count');
          }
          await sleep(60);
        }

        const pendingLeft = await WaCampaignRecipient.count({
          where: { campaign_id: campaign.id, status: 'pending' },
        });
        if (pendingLeft === 0) {
          await campaign.update({ status: 'completed', finished_at: new Date() });
        }
      }
    };

    try {
      if (tenant.schema_name) await runWithTenantSchema(tenant.schema_name, run);
      else await run();
    } catch (err) {
      logger.warn(`[WA Campaigns] tenant ${tenant.id}: ${err.message}`);
    }
  }

  return { sent };
}

module.exports = {
  syncTemplatesForTenant,
  listLocalTemplates,
  createReminderJob,
  processDueReminders,
  createCampaign,
  startCampaign,
  processQueuedCampaigns,
  resolveAudiencePhones,
};
