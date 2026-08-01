// backend/src/services/meta/metaClient.js
// Cliente delgado hacia la Graph API de Meta -- mismo espíritu que
// ncfClient.js: no cachea config en memoria, lee MetaConfig de BD en cada
// llamada para que un cambio desde el panel superadmin surta efecto de
// inmediato.
//
// Cubre lo necesario para el modo "cuenta propia" (OAuth) y la verificación
// de firma de los webhooks (usada tanto por leads en modo "own" como en
// modo "pitbox", ya que ambos llegan al mismo App de Meta). El fetch de
// detalle de un lead y el envío de mensajes de WhatsApp Cloud API quedan
// para cuando se aborde esa fase -- acá se deja el cliente HTTP listo para
// que esa próxima fase solo tenga que agregar el método, no reconstruir la
// base de auth/firma.
const axios = require('axios');
const crypto = require('crypto');
const MetaConfig = require('../../models/payments/MetaConfig');
const logger = require('../../config/logger') || console;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
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
    logger.warn('[Meta] app_secret no configurado -- se omite verificación (inseguro, solo dev)');
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

module.exports = {
  GRAPH_BASE_URL,
  getConfig,
  buildOAuthUrl,
  exchangeCodeForLongLivedToken,
  listManagedPages,
  listLeadForms,
  getLeadDetails,
  verificarFirmaWebhook,
  verificarHandshake,
  probarConexion,
};
