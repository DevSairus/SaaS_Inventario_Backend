// Servicio de negocio WhatsApp Cloud API + coexistencia.
const { Op, fn, col, where: sqlWhere } = require('sequelize');
const logger = require('../config/logger') || console;
const metaClient = require('./meta/metaClient');
const { encryptToken, decryptToken } = require('../utils/metaTokenCrypto');
const { TenantMetaConfig, Tenant, Customer } = require('../models');
const { runWithTenantSchema } = require('../config/tenantContext');
const { windowStatus } = require('../utils/waWorkspacePrefs');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

async function getTenantWaConfig(tenantId) {
  return TenantMetaConfig.findOne({
    where: { tenant_id: tenantId, is_active: true },
  });
}

async function getOrCreateTenantWaConfig(tenantId) {
  const [config] = await TenantMetaConfig.findOrCreate({
    where: { tenant_id: tenantId },
    defaults: { tenant_id: tenantId, is_active: true, wa_demo_mode: false },
  });
  return config;
}

async function isDemoMode(tenantId) {
  const config = await TenantMetaConfig.findOne({ where: { tenant_id: tenantId } });
  return !!config?.wa_demo_mode;
}

async function setDemoMode(tenantId, enabled = true) {
  const config = await getOrCreateTenantWaConfig(tenantId);
  await config.update({
    wa_demo_mode: !!enabled,
    is_active: true,
    own_display_phone: config.own_display_phone || (enabled ? 'Demo Pitbox · Empresa de Pruebas' : config.own_display_phone),
  });
  return getWhatsAppStatus(tenantId);
}

async function resolveAccessToken(tenantConfig) {
  if (!tenantConfig?.own_access_token) return null;
  try {
    return decryptToken(tenantConfig.own_access_token);
  } catch (err) {
    logger.error('[WA Cloud] No se pudo descifrar token:', err.message);
    return null;
  }
}

/**
 * Completa Embedded Signup: guarda WABA + phone_number_id + token cifrado.
 */
async function completeEmbeddedSignup({
  tenantId,
  code,
  wabaId,
  phoneNumberId,
  displayPhone,
  coexistence = true,
}) {
  const metaConfig = await metaClient.getConfig();
  if (!metaConfig?.app_id || !metaConfig?.app_secret) {
    const err = new Error('Pitbox todavía no tiene App de Meta configurada');
    err.status = 400;
    throw err;
  }
  if (!code || !wabaId || !phoneNumberId) {
    const err = new Error('Faltan code, waba_id o phone_number_id');
    err.status = 400;
    throw err;
  }

  const { access_token, expires_in } = await metaClient.exchangeEmbeddedSignupCode({
    appId: metaConfig.app_id,
    appSecret: metaConfig.app_secret,
    code,
  });

  // ── Verificación de propiedad (anti cross-tenant hijack) ────────────────
  // El waba_id/phone_number_id llegan del body del request -- NO se puede
  // confiar en ellos a ciegas: si se guardaran tal cual, un tenant podría
  // (por error o a propósito) registrar el phone_number_id de OTRO tenant,
  // y los webhooks entrantes de ese número terminarían enrutados a su
  // inbox (ver resolverTenantByPhoneNumberId). Por eso acá se confirma
  // contra la Graph API, con el access_token recién canjeado, que el
  // phoneNumberId realmente pertenece al wabaId autorizado en ESTE flujo de
  // Embedded Signup -- no basta con que la llamada a Meta responda 200,
  // tiene que aparecer en la lista de números del WABA.
  const wabaPhoneNumbers = await metaClient.listWabaPhoneNumbers(wabaId, access_token);
  const ownedNumber = wabaPhoneNumbers.find((p) => String(p.id) === String(phoneNumberId));
  if (!ownedNumber) {
    const err = new Error('El número de teléfono indicado no pertenece al WABA autorizado en este inicio de sesión con Meta');
    err.status = 403;
    throw err;
  }
  const display = ownedNumber.display_phone_number || displayPhone || null;

  // Si el número ya está activo y conectado a OTRO tenant, no se permite
  // "robarlo" -- ver también el índice único parcial en la migración
  // 2026080601, esta es la validación a nivel de aplicación (mensaje claro)
  // y esa es la garantía dura a nivel de base de datos.
  const clash = await TenantMetaConfig.findOne({
    where: {
      own_phone_number_id: String(phoneNumberId),
      is_active: true,
      tenant_id: { [Op.ne]: tenantId },
    },
  });
  if (clash) {
    logger.error(`[WA Cloud] Intento de registrar phone_number_id=${phoneNumberId} (ya activo en tenant ${clash.tenant_id}) para tenant ${tenantId}`);
    const err = new Error('Este número de WhatsApp ya está conectado a otra cuenta de Pitbox. Contacta a soporte si crees que esto es un error.');
    err.status = 409;
    throw err;
  }

  const [config] = await TenantMetaConfig.findOrCreate({ where: { tenant_id: tenantId } });
  await config.update({
    provider_mode: config.provider_mode || 'own',
    is_active: true,
    own_waba_id: String(wabaId),
    own_phone_number_id: String(phoneNumberId),
    own_display_phone: display,
    own_access_token: encryptToken(access_token),
    own_token_expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
    wa_coexistence: !!coexistence,
    connected_at: new Date(),
    disconnected_at: null,
    last_error: null,
    wa_history_synced_at: null,
  });

  // Sync de coexistencia: best-effort dentro de 24h
  if (coexistence) {
    try {
      await metaClient.requestCoexistenceSync({
        phoneNumberId,
        accessToken: access_token,
        syncType: 'smb_app_state_sync',
      });
      await config.update({ wa_history_synced_at: new Date() });
    } catch (err) {
      logger.warn('[WA Cloud] Sync coexistencia diferido:', err.response?.data || err.message);
      await config.update({
        last_error: `Sync coexistencia: ${err.response?.data?.error?.message || err.message}`.slice(0, 500),
      });
    }
  }

  return {
    own_waba_id: config.own_waba_id,
    own_phone_number_id: config.own_phone_number_id,
    own_display_phone: config.own_display_phone,
    wa_coexistence: config.wa_coexistence,
    connected_at: config.connected_at,
  };
}

async function getWhatsAppStatus(tenantId) {
  const config = await TenantMetaConfig.findOne({ where: { tenant_id: tenantId } });
  const metaConfig = await metaClient.getConfig();
  const connected = !!(config?.own_phone_number_id && config?.own_access_token && config?.is_active);
  const demoMode = !!config?.wa_demo_mode;
  return {
    connected,
    demo_mode: demoMode,
    // En demo se puede usar el inbox aunque Meta no esté vivo
    operational: connected || demoMode,
    own_waba_id: config?.own_waba_id || null,
    own_phone_number_id: config?.own_phone_number_id || null,
    own_display_phone: config?.own_display_phone || (demoMode ? 'Demo Pitbox' : null),
    wa_coexistence: !!config?.wa_coexistence,
    connected_at: config?.connected_at || null,
    last_wa_message_at: config?.last_wa_message_at || null,
    last_error: config?.last_error || null,
    embedded_signup_config_id: metaConfig?.embedded_signup_config_id || null,
    app_id: metaConfig?.app_id || null,
    graph_version: metaClient.GRAPH_VERSION,
  };
}

async function findOrCreateConversation({ tenantId, schemaName, phone, name, customerId }) {
  const waPhone = normalizePhone(phone);
  const run = async () => {
    const { WaConversation } = require('../models');
    let [conv] = await WaConversation.findOrCreate({
      where: { tenant_id: tenantId, wa_contact_phone: waPhone },
      defaults: {
        tenant_id: tenantId,
        wa_contact_phone: waPhone,
        wa_contact_name: name || null,
        customer_id: customerId || null,
        status: 'open',
        unread_count: 0,
      },
    });
    if (name && !conv.wa_contact_name) {
      await conv.update({ wa_contact_name: name });
    }
    if (customerId && !conv.customer_id) {
      await conv.update({ customer_id: customerId });
    }
    return conv;
  };
  return schemaName ? runWithTenantSchema(schemaName, run) : run();
}

async function appendMessage({
  tenantId,
  schemaName,
  conversationId,
  direction,
  type = 'text',
  body,
  mediaUrl,
  metaMessageId,
  status,
  sentByUserId,
  source,
  rawPayload,
}) {
  const run = async () => {
    const { WaConversation, WaMessage } = require('../models');
    if (metaMessageId) {
      const existing = await WaMessage.findOne({ where: { meta_message_id: metaMessageId } });
      if (existing) return existing;
    }
    const msg = await WaMessage.create({
      tenant_id: tenantId,
      conversation_id: conversationId,
      direction,
      type,
      body: body || null,
      media_url: mediaUrl || null,
      meta_message_id: metaMessageId || null,
      status: status || (direction === 'out' ? 'sent' : 'received'),
      sent_by_user_id: sentByUserId || null,
      source: source || 'api',
      raw_payload: rawPayload || null,
    });
    const updates = {
      last_message_at: new Date(),
    };
    if (direction === 'in') {
      updates.last_inbound_at = new Date();
      await WaConversation.increment('unread_count', { by: 1, where: { id: conversationId } });
    }
    await WaConversation.update(updates, { where: { id: conversationId } });
    return msg;
  };
  return schemaName ? runWithTenantSchema(schemaName, run) : run();
}

async function sendTemplateFromTenant({
  tenantId,
  to,
  templateName,
  language = 'es',
  components = [],
  userId = null,
  source = 'api',
}) {
  const config = await getTenantWaConfig(tenantId);
  if (!config?.own_phone_number_id) {
    const err = new Error('WhatsApp Cloud API no está conectado para este tenant');
    err.status = 400;
    throw err;
  }
  const token = await resolveAccessToken(config);
  if (!token) {
    const err = new Error('Token de WhatsApp no disponible');
    err.status = 400;
    throw err;
  }

  const tenant = await Tenant.findByPk(tenantId);
  const data = await metaClient.sendWhatsAppTemplate({
    phoneNumberId: config.own_phone_number_id,
    accessToken: token,
    to,
    templateName,
    language,
    components,
  });

  const metaMessageId = data?.messages?.[0]?.id || null;
  const conv = await findOrCreateConversation({
    tenantId,
    schemaName: tenant?.schema_name,
    phone: to,
  });
  await appendMessage({
    tenantId,
    schemaName: tenant?.schema_name,
    conversationId: conv.id,
    direction: 'out',
    type: 'template',
    body: `[template:${templateName}]`,
    metaMessageId,
    status: 'sent',
    sentByUserId: userId,
    source,
    rawPayload: data,
  });
  await config.update({ last_wa_message_at: new Date(), last_error: null });
  return { meta: data, conversation_id: conv.id, meta_message_id: metaMessageId };
}

async function sendTextFromTenant({ tenantId, to, body, userId = null, source = 'api' }) {
  const status = await getWhatsAppStatus(tenantId);
  const tenant = await Tenant.findByPk(tenantId);

  // Modo demo: persiste localmente sin llamar a Meta
  if (!status.connected && status.demo_mode) {
    const conv = await findOrCreateConversation({
      tenantId,
      schemaName: tenant?.schema_name,
      phone: to,
    });
    const msg = await appendMessage({
      tenantId,
      schemaName: tenant?.schema_name,
      conversationId: conv.id,
      direction: 'out',
      type: 'text',
      body,
      metaMessageId: `demo_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: 'delivered',
      sentByUserId: userId,
      source: source === 'api' ? 'demo' : source,
    });
    const config = await getOrCreateTenantWaConfig(tenantId);
    await config.update({ last_wa_message_at: new Date(), last_error: null });
    emitConversationEvent(tenantId, conv, msg);
    return {
      meta: { demo: true },
      conversation_id: conv.id,
      meta_message_id: msg.meta_message_id,
      message: msg,
      demo: true,
    };
  }

  const config = await getTenantWaConfig(tenantId);
  if (!config?.own_phone_number_id) {
    const err = new Error('WhatsApp Cloud API no está conectado para este tenant');
    err.status = 400;
    throw err;
  }
  const token = await resolveAccessToken(config);
  if (!token) {
    const err = new Error('Token de WhatsApp no disponible');
    err.status = 400;
    throw err;
  }

  // Ventana de servicio de 24h (Customer Service Window, docs de Meta):
  // texto libre SOLO se puede enviar dentro de las 24h desde el último
  // mensaje entrante del cliente; fuera de esa ventana Meta rechaza el
  // envío con el error 131047 y solo admite plantillas aprobadas (por eso
  // sendTemplateFromTenant NO tiene este chequeo -- las plantillas están
  // hechas justo para iniciar/reabrir conversación). Antes esto no se
  // validaba acá: el agente se enteraba recién cuando Meta devolvía el
  // error luego de intentar enviar. Se avisa antes, con el mismo cálculo
  // (`windowStatus`) que ya se le muestra al asesor en el inbox.
  const conv = await findOrCreateConversation({ tenantId, schemaName: tenant?.schema_name, phone: to });
  const win = windowStatus(conv.last_inbound_at);
  if (!win.open) {
    const err = new Error('La ventana de 24h de este contacto está cerrada -- usa una plantilla aprobada para reiniciar la conversación');
    err.status = 409;
    err.code = 'WA_WINDOW_CLOSED';
    throw err;
  }

  const data = await metaClient.sendWhatsAppText({
    phoneNumberId: config.own_phone_number_id,
    accessToken: token,
    to,
    body,
  });
  const metaMessageId = data?.messages?.[0]?.id || null;
  const msg = await appendMessage({
    tenantId,
    schemaName: tenant?.schema_name,
    conversationId: conv.id,
    direction: 'out',
    type: 'text',
    body,
    metaMessageId,
    status: 'sent',
    sentByUserId: userId,
    source,
    rawPayload: data,
  });
  await config.update({ last_wa_message_at: new Date(), last_error: null });
  emitConversationEvent(tenantId, conv, msg);
  return { meta: data, conversation_id: conv.id, meta_message_id: metaMessageId, message: msg };
}

/**
 * Simula un mensaje entrante del cliente (solo demo) — para demos comerciales.
 */
async function simulateInboundDemo({
  tenantId,
  phone,
  name,
  body,
  type = 'text',
  mediaUrl = null,
}) {
  const status = await getWhatsAppStatus(tenantId);
  if (!status.demo_mode) {
    const err = new Error('El modo demo no está activo para este tenant');
    err.status = 400;
    throw err;
  }
  const tenant = await Tenant.findByPk(tenantId);
  const conv = await findOrCreateConversation({
    tenantId,
    schemaName: tenant?.schema_name,
    phone,
    name,
  });
  const msg = await appendMessage({
    tenantId,
    schemaName: tenant?.schema_name,
    conversationId: conv.id,
    direction: 'in',
    type,
    body,
    mediaUrl,
    metaMessageId: `demo_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: 'received',
    source: 'demo',
  });
  // Refrescar unread / last_inbound
  const { WaConversation } = require('../models');
  const run = async () => WaConversation.findByPk(conv.id);
  const fresh = tenant?.schema_name
    ? await runWithTenantSchema(tenant.schema_name, run)
    : await run();
  emitConversationEvent(tenantId, fresh || conv, msg);
  return { conversation: fresh || conv, message: msg };
}

async function resolverTenantByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return TenantMetaConfig.findOne({
    where: {
      own_phone_number_id: String(phoneNumberId),
      is_active: true,
    },
  });
}

function extractInboundText(message) {
  if (!message) return { type: 'unknown', body: null };
  if (message.type === 'text') return { type: 'text', body: message.text?.body || null };
  if (message.type === 'button') return { type: 'button', body: message.button?.text || message.button?.payload || null };
  if (message.type === 'interactive') {
    const title = message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || null;
    return { type: 'interactive', body: title };
  }
  return { type: message.type || 'unknown', body: `[${message.type || 'media'}]` };
}

/**
 * Procesa un mensaje inbound o echo de coexistencia.
 */
async function ingestInboundWhatsApp({
  phoneNumberId,
  contactPhone,
  contactName,
  message,
  source = 'webhook',
}) {
  const tenantConfig = await resolverTenantByPhoneNumberId(phoneNumberId);
  if (!tenantConfig) {
    logger.warn(`[WA Cloud] Sin tenant para phone_number_id=${phoneNumberId}`);
    return null;
  }
  const tenant = await Tenant.findByPk(tenantConfig.tenant_id);
  if (!tenant) return null;

  const { type, body } = extractInboundText(message);
  const phone = normalizePhone(contactPhone || message?.from);
  if (!phone) return null;

  let customerId = null;
  const findCustomer = async () => {
    const { Customer: Cust } = require('../models');
    // Match exacto primero (normal si el número ya se guardó "limpio"), y
    // como respaldo, comparación normalizada por los últimos 10 dígitos --
    // pero normalizando TAMBIÉN el valor guardado en `phone` (quitando
    // espacios/guiones/+) en vez de un ILIKE crudo contra el string tal
    // cual está en BD. Antes, un cliente guardado como "+57 300 123 4567"
    // nunca hacía match porque el ILIKE comparaba caracteres literales, no
    // dígitos -- y a la inversa, un ILIKE sin normalizar es más propenso a
    // falsos positivos entre dos números que casualmente comparten los
    // mismos caracteres finales pero con separadores distintos.
    const last10 = phone.slice(-10);
    const c = await Cust.findOne({
      where: {
        tenant_id: tenant.id,
        [Op.or]: [
          { phone },
          sqlWhere(fn('regexp_replace', col('phone'), '\\D', '', 'g'), { [Op.like]: `%${last10}` }),
        ],
      },
    });
    return c?.id || null;
  };
  try {
    customerId = tenant.schema_name
      ? await runWithTenantSchema(tenant.schema_name, findCustomer)
      : await findCustomer();
  } catch (_) { /* customer opcional */ }

  const conv = await findOrCreateConversation({
    tenantId: tenant.id,
    schemaName: tenant.schema_name,
    phone,
    name: contactName,
    customerId,
  });

  const msg = await appendMessage({
    tenantId: tenant.id,
    schemaName: tenant.schema_name,
    conversationId: conv.id,
    direction: source === 'app_echo' ? 'out' : 'in',
    type,
    body,
    metaMessageId: message?.id || null,
    status: source === 'app_echo' ? 'sent' : 'received',
    source,
    rawPayload: message,
  });

  await tenantConfig.update({ last_wa_message_at: new Date(), last_error: null });

  const freshConv = await (async () => {
    const { WaConversation } = require('../models');
    const run = async () => WaConversation.findByPk(conv.id);
    return tenant.schema_name ? runWithTenantSchema(tenant.schema_name, run) : run();
  })();
  emitConversationEvent(tenant.id, freshConv || conv, msg);

  return { tenantId: tenant.id, conversationId: conv.id, messageId: msg.id };
}

async function updateMessageStatus({ metaMessageId, status, tenantId = null }) {
  if (!metaMessageId || !status) return;
  try {
    const { WaMessage } = require('../models');
    await WaMessage.update(
      { status },
      { where: { meta_message_id: metaMessageId } }
    );
    if (tenantId) {
      try {
        const { emitWaTenant } = require('./whatsappNotifications.socket');
        emitWaTenant(tenantId, 'wa:message-status', { meta_message_id: metaMessageId, status });
      } catch (_) { /* socket opcional */ }
    }
  } catch (err) {
    logger.debug?.(`[WA Cloud] status update skip: ${err.message}`);
  }
}

async function disconnectWhatsApp(tenantId) {
  const config = await TenantMetaConfig.findOne({ where: { tenant_id: tenantId } });
  if (!config) {
    const err = new Error('No hay configuración WhatsApp para este tenant');
    err.status = 404;
    throw err;
  }
  await config.update({
    is_active: false,
    own_access_token: null,
    own_token_expires_at: null,
    disconnected_at: new Date(),
    last_error: null,
  });
  return { disconnected: true };
}

function emitConversationEvent(tenantId, conversation, message) {
  try {
    const { emitWaTenant, emitWaUser, emitWaConversation } = require('./whatsappNotifications.socket');
    const payload = {
      conversation_id: conversation.id,
      conversation: {
        id: conversation.id,
        wa_contact_phone: conversation.wa_contact_phone,
        wa_contact_name: conversation.wa_contact_name,
        assigned_user_id: conversation.assigned_user_id,
        unread_count: conversation.unread_count,
        last_message_at: conversation.last_message_at,
        status: conversation.status,
      },
      message: message
        ? {
            id: message.id,
            conversation_id: message.conversation_id,
            direction: message.direction,
            type: message.type,
            body: message.body,
            media_url: message.media_url,
            status: message.status,
            source: message.source,
            created_at: message.created_at,
          }
        : null,
    };
    emitWaTenant(tenantId, 'wa:new-message', payload);
    emitWaConversation(conversation.id, 'wa:new-message', payload);
    if (conversation.assigned_user_id) {
      emitWaUser(conversation.assigned_user_id, 'wa:new-message', payload);
    }
  } catch (_) { /* socket opcional en tests/serverless */ }
}


async function sendMediaFromTenant({
  tenantId,
  to,
  type,
  fileBuffer,
  mimeType,
  filename,
  caption = null,
  userId = null,
  source = 'api',
}) {
  const status = await getWhatsAppStatus(tenantId);
  const tenant = await Tenant.findByPk(tenantId);
  const { uploadToCloudinary } = require('../utils/uploadToCloudinary');

  // Siempre guardamos copia en nuestro storage (demo y live)
  const uploaded = await uploadToCloudinary(
    fileBuffer,
    filename || `wa-${type}-${Date.now()}`,
    `whatsapp/${tenantId}`,
    { mimeType, waType: type }
  );
  let mediaUrl = uploaded.url;
  if (mediaUrl && mediaUrl.startsWith('/')) {
    const port = process.env.PORT || 5001;
    const base = (process.env.BACKEND_URL || `http://localhost:${port}`).replace(/\/$/, '').replace(/\/api$/, '');
    mediaUrl = `${base}${mediaUrl}`;
  }
  // Nunca usar FRONTEND_URL como host de media (rompe audio/archivos)
  if (mediaUrl && process.env.FRONTEND_URL && mediaUrl.startsWith(process.env.FRONTEND_URL)) {
    const port = process.env.PORT || 5001;
    mediaUrl = mediaUrl.replace(process.env.FRONTEND_URL.replace(/\/$/, ''), `http://localhost:${port}`);
  }

  const bodyLabel = caption
    || (type === 'audio' ? '🎤 Audio'
      : type === 'image' ? '📷 Imagen'
        : type === 'video' ? '🎬 Video'
          : `📎 ${filename || 'Archivo'}`);

  if (!status.connected && status.demo_mode) {
    const conv = await findOrCreateConversation({
      tenantId,
      schemaName: tenant?.schema_name,
      phone: to,
    });
    const msg = await appendMessage({
      tenantId,
      schemaName: tenant?.schema_name,
      conversationId: conv.id,
      direction: 'out',
      type,
      body: bodyLabel,
      mediaUrl,
      metaMessageId: `demo_media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: 'delivered',
      sentByUserId: userId,
      source: source === 'api' ? 'demo' : source,
      rawPayload: {
        mimeType,
        filename,
        demo: true,
        resource_type: uploaded.resource_type,
        format: uploaded.format || null,
      },
    });
    const config = await getOrCreateTenantWaConfig(tenantId);
    await config.update({ last_wa_message_at: new Date(), last_error: null });
    emitConversationEvent(tenantId, conv, msg);
    return {
      meta: { demo: true },
      conversation_id: conv.id,
      meta_message_id: msg.meta_message_id,
      message: msg,
      demo: true,
    };
  }

  const config = await getTenantWaConfig(tenantId);
  if (!config?.own_phone_number_id) {
    const err = new Error('WhatsApp Cloud API no está conectado para este tenant');
    err.status = 400;
    throw err;
  }
  const token = await resolveAccessToken(config);
  if (!token) {
    const err = new Error('Token de WhatsApp no disponible');
    err.status = 400;
    throw err;
  }

  const uploadedMeta = await metaClient.uploadWhatsAppMediaBinary({
    phoneNumberId: config.own_phone_number_id,
    accessToken: token,
    fileBuffer,
    mimeType,
    filename: filename || 'file',
  });
  const mediaId = uploadedMeta?.id;
  if (!mediaId) {
    const err = new Error('Meta no devolvió media id');
    err.status = 502;
    throw err;
  }

  const data = await metaClient.sendWhatsAppMedia({
    phoneNumberId: config.own_phone_number_id,
    accessToken: token,
    to,
    type,
    mediaId,
    caption,
    filename,
  });

  const metaMessageId = data?.messages?.[0]?.id || null;
  const conv = await findOrCreateConversation({
    tenantId,
    schemaName: tenant?.schema_name,
    phone: to,
  });
  const msg = await appendMessage({
    tenantId,
    schemaName: tenant?.schema_name,
    conversationId: conv.id,
    direction: 'out',
    type,
    body: bodyLabel,
    mediaUrl,
    metaMessageId,
    status: 'sent',
    sentByUserId: userId,
    source,
    rawPayload: { ...data, mimeType, filename, meta_media_id: mediaId, resource_type: uploaded.resource_type },
  });
  await config.update({ last_wa_message_at: new Date(), last_error: null });
  emitConversationEvent(tenantId, conv, msg);
  return { meta: data, conversation_id: conv.id, meta_message_id: metaMessageId, message: msg };
}


module.exports = {
  normalizePhone,
  completeEmbeddedSignup,
  getWhatsAppStatus,
  sendTemplateFromTenant,
  sendTextFromTenant,
  ingestInboundWhatsApp,
  updateMessageStatus,
  disconnectWhatsApp,
  resolverTenantByPhoneNumberId,
  findOrCreateConversation,
  resolveAccessToken,
  getTenantWaConfig,
  getOrCreateTenantWaConfig,
  emitConversationEvent,
  isDemoMode,
  setDemoMode,
  simulateInboundDemo,
  appendMessage,
  sendMediaFromTenant,
};
