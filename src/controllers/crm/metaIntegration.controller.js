// backend/src/controllers/crm/metaIntegration.controller.js
// Conexión del tenant con Meta -- dos modos, ver TenantMetaConfig.js:
//   'own'    -- OAuth contra la página/WABA propia del tenant.
//   'pitbox' -- opt-in al App/página compartida de Pitbox; el mapeo de
//               qué formularios de Lead Ads le pertenecen lo completa
//               soporte/superadmin a mano (ver superadmin.routes.js),
//               no hay autoservicio para esa parte todavía.
const jwt = require('jsonwebtoken');
const logger = require('../../config/logger') || console;
const { TenantMetaConfig } = require('../../models');
const metaClient = require('../../services/meta/metaClient');

const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'http://localhost:5000';
// OJO: vive bajo /api/webhooks/meta (ruta PÚBLICA, sin authMiddleware) y no
// bajo /api/crm/meta-integration -- el navegador llega acá recién saliendo
// del diálogo de Meta, sin el Bearer token de la sesión de Pitbox. El
// tenant se identifica por el `state` firmado, no por el JWT de sesión.
const CALLBACK_PATH = '/api/webhooks/meta/oauth-callback';

const getStatus = async (req, res) => {
  try {
    const config = await TenantMetaConfig.findOne({ where: { tenant_id: req.tenant_id } });
    if (!config) {
      return res.json({ success: true, data: { provider_mode: null, is_active: false } });
    }
    res.json({
      success: true,
      data: {
        provider_mode: config.provider_mode,
        is_active: config.is_active,
        own_page_name: config.own_page_name || null,
        own_page_id: config.own_page_id || null,
        has_own_token: !!config.own_access_token,
        pitbox_lead_form_count: (config.pitbox_lead_form_ids || []).length,
        connected_at: config.connected_at,
        last_lead_at: config.last_lead_at,
        last_error: config.last_error,
      },
    });
  } catch (error) {
    logger.error('[Meta Integration] Error obteniendo estado:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el estado de la integración' });
  }
};

// Devuelve la URL del diálogo OAuth de Meta -- el frontend redirige al
// usuario ahí (window.location.href = url), no es un fetch de background.
const startOwnConnection = async (req, res) => {
  try {
    const metaConfig = await metaClient.getConfig();
    if (!metaConfig?.app_id) {
      return res.status(400).json({ success: false, message: 'Pitbox todavía no tiene una App de Meta configurada -- contacta a soporte.' });
    }

    const state = jwt.sign({ tenant_id: req.tenant_id, purpose: 'meta_oauth' }, JWT_SECRET, { expiresIn: '15m' });
    const url = metaClient.buildOAuthUrl({
      appId: metaConfig.app_id,
      redirectUri: `${BACKEND_PUBLIC_URL}${CALLBACK_PATH}`,
      state,
    });

    res.json({ success: true, data: { oauth_url: url } });
  } catch (error) {
    logger.error('[Meta Integration] Error iniciando conexión OAuth:', error);
    res.status(500).json({ success: false, message: 'Error al iniciar la conexión con Meta' });
  }
};

// Callback del diálogo OAuth -- lo llama el navegador del usuario tras
// autorizar en Meta, SIN el Bearer token de la sesión de Pitbox (por eso
// esta ruta es pública y el tenant se identifica por el `state` firmado,
// no por authMiddleware -- ver metaWebhook.routes.js para el mismo criterio
// aplicado a otro tipo de callback externo).
const handleOwnCallback = async (req, res) => {
  const { code, state, error: metaError } = req.query;
  const redirectKo = (msg) => res.redirect(`${FRONTEND_URL}/crm/settings/meta?connected=0&message=${encodeURIComponent(msg)}`);

  if (metaError) return redirectKo('Autorización rechazada en Meta');
  if (!code || !state) return redirectKo('Falta code o state en el callback');

  let tenantId;
  try {
    const decoded = jwt.verify(state, JWT_SECRET);
    if (decoded.purpose !== 'meta_oauth') throw new Error('state con propósito inválido');
    tenantId = decoded.tenant_id;
  } catch (err) {
    logger.warn('[Meta Integration] state inválido/expirado en callback:', err.message);
    return redirectKo('El enlace de conexión expiró, intenta de nuevo');
  }

  try {
    const metaConfig = await metaClient.getConfig();
    const { access_token: userToken, expires_in } = await metaClient.exchangeCodeForLongLivedToken({
      appId: metaConfig.app_id,
      appSecret: metaConfig.app_secret,
      redirectUri: `${BACKEND_PUBLIC_URL}${CALLBACK_PATH}`,
      code,
    });

    const pages = await metaClient.listManagedPages(userToken);
    if (!pages.length) return redirectKo('No se encontró ninguna página de Facebook administrada por este usuario');

    // TODO (fase siguiente): si administra más de una página, dejar elegir
    // desde el frontend en vez de tomar la primera -- hoy cubre el caso más
    // común (un tenant chico con una sola página).
    const page = pages[0];

    const [config] = await TenantMetaConfig.findOrCreate({ where: { tenant_id: tenantId } });
    await config.update({
      provider_mode: 'own',
      is_active: true,
      own_page_id: page.id,
      own_page_name: page.name,
      own_access_token: page.access_token || userToken,
      own_token_expires_at: expires_in ? new Date(Date.now() + expires_in * 1000) : null,
      connected_at: new Date(),
      disconnected_at: null,
      last_error: null,
    });

    res.redirect(`${FRONTEND_URL}/crm/settings/meta?connected=1`);
  } catch (error) {
    logger.error('[Meta Integration] Error en callback OAuth:', error.response?.data || error.message);
    redirectKo('No se pudo completar la conexión con Meta');
  }
};

const connectPitboxMode = async (req, res) => {
  try {
    const metaConfig = await metaClient.getConfig();
    if (!metaConfig?.is_active) {
      return res.status(400).json({ success: false, message: 'El servicio de Meta compartido de Pitbox no está activo -- contacta a soporte.' });
    }

    const [config] = await TenantMetaConfig.findOrCreate({ where: { tenant_id: req.tenant_id } });
    await config.update({
      provider_mode: 'pitbox',
      is_active: true,
      connected_at: new Date(),
      disconnected_at: null,
      last_error: null,
    });

    res.json({
      success: true,
      message: 'Activado el servicio de Meta de Pitbox. Un asesor de soporte va a contactarte para vincular tus formularios de anuncios.',
      data: { provider_mode: config.provider_mode },
    });
  } catch (error) {
    logger.error('[Meta Integration] Error activando modo Pitbox:', error);
    res.status(500).json({ success: false, message: 'Error al activar el servicio de Meta' });
  }
};

const disconnect = async (req, res) => {
  try {
    const config = await TenantMetaConfig.findOne({ where: { tenant_id: req.tenant_id } });
    if (!config) return res.status(404).json({ success: false, message: 'No hay una conexión de Meta activa' });

    await config.update({
      provider_mode: null,
      is_active: false,
      own_access_token: null,
      own_page_id: null,
      own_page_name: null,
      own_waba_id: null,
      own_phone_number_id: null,
      own_token_expires_at: null,
      pitbox_lead_form_ids: [],
      disconnected_at: new Date(),
    });

    res.json({ success: true, message: 'Conexión con Meta desactivada' });
  } catch (error) {
    logger.error('[Meta Integration] Error desconectando:', error);
    res.status(500).json({ success: false, message: 'Error al desconectar' });
  }
};

module.exports = { getStatus, startOwnConnection, handleOwnCallback, connectPitboxMode, disconnect };
