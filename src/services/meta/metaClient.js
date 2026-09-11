// backend/src/services/meta/metaClient.js
// Cliente delgado hacia la Graph API de Meta -- mismo espíritu que
// ncfClient.js: no cachea config en memoria, lee MetaConfig de BD en cada
// llamada para que un cambio desde el panel superadmin surta efecto de
// inmediato.
//
// Lead Ads (OAuth/webhooks) + WhatsApp Cloud API (plantillas, texto,
// Embedded Signup / coexistencia). Firma HMAC compartida para todos los
// webhooks de la misma App de Meta.
const axios = require('axios');
const crypto = require('crypto');
const MetaConfig = require('../../models/payments/MetaConfig');
const TenantMetaConfig = require('../../models/payments/TenantMetaConfig');
const logger = require('../../config/logger') || console;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function getConfig() {
  const config = await MetaConfig.findOne();
  if (!config) return null;
  return config;
}

/**
 * URL del diálogo OAuth de Meta para que un tenant conecte SU propia
 * página/cuenta de anuncios ("cuenta propia"). `state` debe ser un valor
 * firmado/verificable que permita identificar al tenant en el callback sin
 * confiar en lo que el navegador devuelva sin más -- ver
 * routes/tenant/metaIntegration.routes.js (usa el JWT de sesión + un nonce
 * corto, no state en texto plano).
 */
function buildOAuthUrl({ appId, redirectUri, state, scopes }) {
  const defaultScopes = [
    'pages_show_list',
    'leads_retrieval',
    'pages_manage_metadata',
    'business_management',
  ];
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: (scopes || defaultScopes).join(','),
    response_type: 'code',
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

/**
 * Intercambia el `code` del callback OAuth por un token de acceso, y ese
 * token corto por uno de larga duración (~60 días) en el mismo paso --
 * Meta lo documenta como dos llamadas GET encadenadas sobre /oauth/access_token.
 */
async function exchangeCodeForLongLivedToken({ appId, appSecret, redirectUri, code }) {
  const shortLived = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    timeout: 15000,
  });
  const shortToken = shortLived.data?.access_token;
  if (!shortToken) throw new Error('Meta no devolvió access_token en el intercambio de code');

  const longLived = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
    timeout: 15000,
  });

  return {
    access_token: longLived.data?.access_token || shortToken,
    expires_in: longLived.data?.expires_in || null, // segundos, típicamente ~5184000 (60 días)
  };
}

/**
 * Páginas de Facebook que administra el usuario que autorizó el OAuth --
 * se muestra un selector en el frontend si administra más de una.
 */
async function listManagedPages(userAccessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/me/accounts`, {
    params: { access_token: userAccessToken },
    timeout: 15000,
  });
  return data?.data || []; // [{ id, name, access_token }, ...] -- el access_token acá ya es el de PÁGINA
}

/**
 * Formularios de Lead Ads de una página -- se guardan sus IDs en
 * TenantMetaConfig.own_page_id (modo "own") o en pitbox_lead_form_ids
 * (modo "pitbox", asignación manual de soporte) para poder reconocer a qué
 * tenant pertenece cada lead entrante.
 */
async function listLeadForms(pageId, pageAccessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/${pageId}/leadgen_forms`, {
    params: { access_token: pageAccessToken },
    timeout: 15000,
  });
  return data?.data || [];
}

/**
 * Detalle de un lead puntual -- el webhook de `leadgen` solo trae el ID,
 * hay que pedir los campos del formulario aparte.
 */
async function getLeadDetails(leadgenId, pageAccessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/${leadgenId}`, {
    params: { access_token: pageAccessToken },
    timeout: 15000,
  });
  return data; // { id, created_time, field_data: [{ name, values }], ad_id, form_id, ... }
}

/**
 * Página (id de Facebook) que administra un App propia de tenant o el App
 * compartido de Pitbox -- resuelve con qué App Secret hay que verificar la
 * firma de un webhook entrante, ANTES de confiar en el body. Cada tenant en
 * modo "own" con su propia App recibe los webhooks de su propia página
 * firmados con SU app_secret, no con el de Pitbox -- por eso no alcanza un
 * único secret global (a diferencia del modo "pitbox", que sí comparte
 * página y App con todos los tenants en ese modo).
 */
async function resolveAppSecretForPage(pageId) {
  if (pageId) {
    const tenantConfig = await TenantMetaConfig.findOne({
      where: { provider_mode: 'own', own_page_id: pageId },
    });
    if (tenantConfig?.own_app_secret) {
      return { appSecret: tenantConfig.own_app_secret, source: 'own' };
    }
  }
  const config = await getConfig();
  if (config?.app_secret) return { appSecret: config.app_secret, source: 'pitbox' };
  return { appSecret: null, source: null };
}

/**
 * WABA (WhatsApp Business Account) que administra un App propia de tenant.
 *
 * Los webhooks de WhatsApp NO traen page_id: en `entry[0].id` viene el WABA
 * ID. Resolver el secret solo por página (resolveAppSecretForPage) hacía que
 * un tenant en modo "own" con App propia y únicamente WhatsApp conectado
 * cayera al app_secret de Pitbox -- y la verificación de firma fallara
 * (webhook descartado) o, peor, se validara contra el secret equivocado.
 */
async function resolveAppSecretForWaba(wabaId) {
  if (wabaId) {
    const tenantConfig = await TenantMetaConfig.findOne({
      where: { provider_mode: 'own', own_waba_id: String(wabaId) },
    });
    if (tenantConfig?.own_app_secret) {
      return { appSecret: tenantConfig.own_app_secret, source: 'own' };
    }
  }
  const config = await getConfig();
  if (config?.app_secret) return { appSecret: config.app_secret, source: 'pitbox' };
  return { appSecret: null, source: null };
}

/**
 * Verifica la firma `X-Hub-Signature-256: sha256=<hex>` que Meta manda en
 * cada webhook, calculada como HMAC-SHA256 del body crudo usando el App
 * Secret correspondiente (ver resolveAppSecretForPage -- el caller ya lo
 * resolvió antes de llamar acá). Mismo patrón que ncfClient.verificarFirmaWebhook.
 */
async function verificarFirmaWebhook(rawBody, signatureHeader, appSecret) {
  if (!appSecret) {
    // Antes esto devolvía `true` (aceptaba CUALQUIER webhook sin firma) --
    // en producción eso permite que cualquiera con la URL del endpoint
    // falsifique leads/mensajes de WhatsApp de cualquier tenant. Ahora solo
    // se tolera en desarrollo/pruebas, donde es común no tener todavía el
    // app_secret real cargado en el panel superadmin.
    if (process.env.NODE_ENV === 'production') {
      logger.error('[Meta] no se pudo resolver ningún app_secret -- se rechaza el webhook (producción exige firma válida)');
      return false;
    }
    logger.warn('[Meta] no se pudo resolver ningún app_secret -- se omite verificación (inseguro, solo dev)');
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handshake GET que Meta hace UNA vez al configurar la suscripción del
 * webhook en el dashboard de cada App (hub.mode=subscribe, hub.verify_token,
 * hub.challenge). El handshake no trae ningún identificador de tenant/página,
 * solo el token -- hay que aceptarlo si coincide con el de Pitbox (modo
 * "pitbox") O con el que cualquier tenant registró en SU propia App (modo
 * "own"). Hay que devolver hub.challenge tal cual si coincide con alguno.
 */
async function verificarHandshake({ mode, verifyToken, challenge }) {
  if (mode !== 'subscribe' || !verifyToken) return null;

  const config = await getConfig();
  if (config?.webhook_verify_token && verifyToken === config.webhook_verify_token) {
    return challenge;
  }

  const tenantConfig = await TenantMetaConfig.findOne({
    where: { provider_mode: 'own', own_webhook_verify_token: verifyToken },
  });
  if (tenantConfig) return challenge;

  return null;
}

async function probarConexion() {
  const config = await getConfig();
  if (!config) return { ok: false, message: 'No hay configuración de Meta guardada todavía.' };
  if (!config.app_id || !config.app_secret) {
    return { ok: false, message: 'Faltan app_id o app_secret en la configuración.' };
  }

  try {
    // /debug_token con el propio App Secret como token de app -- confirma
    // que el App ID/Secret son válidos sin necesitar un token de usuario.
    const appToken = `${config.app_id}|${config.app_secret}`;
    const { data } = await axios.get(`${GRAPH_BASE_URL}/app`, {
      params: { access_token: appToken },
      timeout: 15000,
    });
    const message = `App "${data.name || config.app_id}" verificada correctamente`;
    await config.update({ last_test_at: new Date(), last_test_ok: true, last_test_message: message });
    return { ok: true, message };
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    await config.update({ last_test_at: new Date(), last_test_ok: false, last_test_message: message });
    return { ok: false, message };
  }
}

/**
 * Intercambia el `code` de Embedded Signup (FB.login) por access token.
 * Docs: WhatsApp Embedded Signup / Onboard Business App users.
 */
async function exchangeEmbeddedSignupCode({ appId, appSecret, code }) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/oauth/access_token`, {
    params: {
      client_id: appId,
      client_secret: appSecret,
      code,
    },
    timeout: 20000,
  });
  if (!data?.access_token) throw new Error('Meta no devolvió access_token en Embedded Signup');
  return {
    access_token: data.access_token,
    expires_in: data.expires_in || null,
    token_type: data.token_type || 'bearer',
  };
}

/** Lista números de un WABA. */
async function listWabaPhoneNumbers(wabaId, accessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/${wabaId}/phone_numbers`, {
    params: {
      access_token: accessToken,
      fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status',
    },
    timeout: 15000,
  });
  return data?.data || [];
}

async function getPhoneNumberDetails(phoneNumberId, accessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/${phoneNumberId}`, {
    params: {
      access_token: accessToken,
      fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status',
    },
    timeout: 15000,
  });
  return data;
}

/**
 * Envía plantilla aprobada por Meta.
 * POST /{phone-number-id}/messages
 */
async function sendWhatsAppTemplate({
  phoneNumberId,
  accessToken,
  to,
  templateName,
  language = 'es',
  components = [],
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      ...(components.length ? { components } : {}),
    },
  };
  const { data } = await axios.post(
    `${GRAPH_BASE_URL}/${phoneNumberId}/messages`,
    payload,
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return data;
}

/** Texto libre — solo dentro de ventana 24h de conversación. */
async function sendWhatsAppText({ phoneNumberId, accessToken, to, body }) {
  const payload = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'text',
    text: { preview_url: true, body },
  };
  const { data } = await axios.post(
    `${GRAPH_BASE_URL}/${phoneNumberId}/messages`,
    payload,
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return data;
}

/**
 * Sube binario a Meta Cloud API y retorna media id.
 * POST /{phone-number-id}/media
 */
async function uploadWhatsAppMediaBinary({
  phoneNumberId,
  accessToken,
  fileBuffer,
  mimeType,
  filename,
}) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', fileBuffer, {
    filename: filename || 'file',
    contentType: mimeType,
  });

  const { data } = await axios.post(
    `${GRAPH_BASE_URL}/${phoneNumberId}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...form.getHeaders(),
      },
      timeout: 60000,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 20 * 1024 * 1024,
    }
  );
  return data; // { id }
}

/**
 * Envía media (image|audio|video|document) por Cloud API.
 */
async function sendWhatsAppMedia({
  phoneNumberId,
  accessToken,
  to,
  type,
  mediaId,
  caption,
  filename,
}) {
  const mediaKey = type === 'document' ? 'document' : type;
  const mediaPayload = { id: mediaId };
  if (caption && ['image', 'video', 'document'].includes(type)) {
    mediaPayload.caption = caption;
  }
  if (filename && type === 'document') {
    mediaPayload.filename = filename;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type,
    [mediaKey]: mediaPayload,
  };

  const { data } = await axios.post(
    `${GRAPH_BASE_URL}/${phoneNumberId}/messages`,
    payload,
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return data;
}

/**
 * Lista plantillas del WABA (message_templates).
 * GET /{waba-id}/message_templates
 */
async function listWabaMessageTemplates(wabaId, accessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/${wabaId}/message_templates`, {
    params: { limit: 100, fields: 'name,language,status,category,components,id' },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });
  return data?.data || [];
}

/**
 * Inspecciona un access token contra la App de Pitbox.
 *
 * Se usa al conectar un número con token PERMANENTE (System User): permite
 * confirmar, antes de guardarlo, que el token es válido, de qué App es y si
 * realmente no expira (`expires_at === 0` en la respuesta de Meta significa
 * "nunca"). Sin esto, un token pegado a mano solo se descubría inválido
 * cuando fallaba el primer envío real a un cliente.
 */
async function debugToken(inputToken) {
  const config = await getConfig();
  if (!config?.app_id || !config?.app_secret) {
    throw new Error('Pitbox no tiene App de Meta configurada (app_id / app_secret)');
  }
  const appToken = `${config.app_id}|${config.app_secret}`;
  const { data } = await axios.get(`${GRAPH_BASE_URL}/debug_token`, {
    params: { input_token: inputToken, access_token: appToken },
    timeout: 15000,
  });
  const info = data?.data || {};
  return {
    valid: !!info.is_valid,
    app_id: info.app_id || null,
    scopes: info.scopes || [],
    type: info.type || null,
    // Meta usa 0 para "no expira" (tokens de System User)
    expires_at: info.expires_at ? new Date(info.expires_at * 1000) : null,
    never_expires: info.expires_at === 0,
    error: info.error?.message || null,
  };
}

/**
 * URL temporal de descarga de un media entrante.
 * El webhook solo trae el `media_id`; el binario se pide en dos pasos.
 */
async function getMediaUrl(mediaId, accessToken) {
  const { data } = await axios.get(`${GRAPH_BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return data; // { url, mime_type, sha256, file_size, id }
}

/**
 * Descarga el binario de un media de WhatsApp.
 * La URL de Meta exige el header Authorization (no es pública).
 */
async function downloadMedia(mediaUrl, accessToken) {
  const { data } = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 30 * 1024 * 1024,
  });
  return Buffer.from(data);
}

/**
 * Marca un mensaje entrante como leído en WhatsApp (doble check azul del
 * lado del cliente). Best-effort: si falla, el inbox local igual queda leído.
 */
async function markMessageRead({ phoneNumberId, accessToken, metaMessageId }) {
  const { data } = await axios.post(
    `${GRAPH_BASE_URL}/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', status: 'read', message_id: metaMessageId },
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 15000,
      validateStatus: (s) => s < 500,
    }
  );
  return data;
}

/**
 * Dispara sync de historial / contactos de coexistencia (solo una vez, <24h
 * tras onboarding). Docs: smb_app_state_sync + history.
 */
async function requestCoexistenceSync({ phoneNumberId, accessToken, syncType = 'smb_app_state_sync' }) {
  // Endpoint puede variar por versión; se documenta y se llama de forma
  // tolerante — si Meta rechaza, el caller registra last_error.
  const { data } = await axios.post(
    `${GRAPH_BASE_URL}/${phoneNumberId}/smb_app_data`,
    { messaging_product: 'whatsapp', sync_type: syncType },
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 20000,
      validateStatus: (s) => s < 500,
    }
  );
  return data;
}

module.exports = {
  GRAPH_BASE_URL,
  GRAPH_VERSION,
  getConfig,
  buildOAuthUrl,
  exchangeCodeForLongLivedToken,
  exchangeEmbeddedSignupCode,
  listManagedPages,
  listLeadForms,
  getLeadDetails,
  resolveAppSecretForPage,
  resolveAppSecretForWaba,
  listWabaPhoneNumbers,
  getPhoneNumberDetails,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  uploadWhatsAppMediaBinary,
  sendWhatsAppMedia,
  listWabaMessageTemplates,
  requestCoexistenceSync,
  debugToken,
  getMediaUrl,
  downloadMedia,
  markMessageRead,
  verificarFirmaWebhook,
  verificarHandshake,
  probarConexion,
};
