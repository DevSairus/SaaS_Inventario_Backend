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
 * Verifica la firma `X-Hub-Signature-256: sha256=<hex>` que Meta manda en
 * cada webhook, calculada como HMAC-SHA256 del body crudo usando el App
 * Secret. Mismo patrón que ncfClient.verificarFirmaWebhook.
 */
async function verificarFirmaWebhook(rawBody, signatureHeader) {
  const config = await getConfig();
  if (!config?.app_secret) {
    // Antes esto devolvía `true` (aceptaba CUALQUIER webhook sin firma) --
    // en producción eso permite que cualquiera con la URL del endpoint
    // falsifique leads/mensajes de WhatsApp de cualquier tenant. Ahora solo
    // se tolera en desarrollo/pruebas, donde es común no tener todavía el
    // app_secret real cargado en el panel superadmin.
    if (process.env.NODE_ENV === 'production') {
      logger.error('[Meta] app_secret no configurado -- se rechaza el webhook (producción exige firma válida)');
      return false;
    }
    logger.warn('[Meta] app_secret no configurado -- se omite verificación (inseguro, solo dev/test)');
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = crypto.createHmac('sha256', config.app_secret).update(rawBody).digest('hex');
  const received = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Handshake GET que Meta hace UNA vez al configurar la suscripción del
 * webhook en el dashboard de la App (hub.mode=subscribe, hub.verify_token,
 * hub.challenge). Hay que devolver hub.challenge tal cual si el token
 * coincide con el guardado en MetaConfig.
 */
async function verificarHandshake({ mode, verifyToken, challenge }) {
  if (mode !== 'subscribe') return null;
  const config = await getConfig();
  if (!config?.webhook_verify_token) return null;
  if (verifyToken !== config.webhook_verify_token) return null;
  return challenge;
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
  listWabaPhoneNumbers,
  getPhoneNumberDetails,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  uploadWhatsAppMediaBinary,
  sendWhatsAppMedia,
  listWabaMessageTemplates,
  requestCoexistenceSync,
  verificarFirmaWebhook,
  verificarHandshake,
  probarConexion,
};
