// backend/src/services/ncf/ncfClient.js
// Cliente delgado hacia el Núcleo Central de Facturación (NCF) de ESC
// DataCore. Pitbox es un "SistemaOrigen" más frente al Núcleo (junto con
// DOCUCORE, CliniCore, Lu Store) -- este archivo es el equivalente del
// `ncfClient.js` mencionado en el roadmap de Fase 2.
//
// No cachea la config en memoria a propósito: se lee de BD en cada llamada
// para que un cambio de credenciales desde el panel superadmin surta efecto
// de inmediato, sin reiniciar el proceso.
const axios = require('axios');
const crypto = require('crypto');
const NcfConfig = require('../../models/payments/NcfConfig');
const logger = require('../../config/logger') || console;

async function getConfig() {
  const config = await NcfConfig.findOne();
  if (!config) return null;
  return config;
}

function buildClient(config) {
  if (!config?.ncf_base_url || !config?.ncf_api_key) return null;
  return axios.create({
    baseURL: config.ncf_base_url.replace(/\/+$/, ''),
    headers: { 'x-ncf-api-key': config.ncf_api_key },
    timeout: 15000,
  });
}

/**
 * Prueba la conexión con el Núcleo: valida que la URL responde y que la
 * API key es válida (no solo que el servidor está arriba). Actualiza
 * NcfConfig.last_test_* para que el panel muestre el resultado sin tener
 * que volver a probar.
 */
async function probarConexion() {
  const config = await getConfig();
  if (!config) {
    return { ok: false, message: 'No hay configuración NCF guardada todavía.' };
  }
  if (!config.ncf_base_url || !config.ncf_api_key) {
    return { ok: false, message: 'Faltan ncf_base_url o ncf_api_key en la configuración.' };
  }

  const client = buildClient(config);
  let result;

  try {
    await client.get('/prefacturas', { params: { limit: 1 } });
    result = { ok: true, message: 'Conexión exitosa: la API key fue aceptada por el Núcleo.' };
  } catch (err) {
    if (err.response?.status === 401) {
      result = { ok: false, message: 'El Núcleo respondió 401: la API key es inválida o fue rotada.' };
    } else if (err.response) {
      result = { ok: false, message: `El Núcleo respondió ${err.response.status}: ${err.response.data?.error || err.message}` };
    } else {
      result = { ok: false, message: `No se pudo alcanzar ${config.ncf_base_url}: ${err.message}` };
    }
  }

  await config.update({
    last_test_at: new Date(),
    last_test_ok: result.ok,
    last_test_message: result.message,
  });

  return result;
}

/**
 * Envía una prefactura al Núcleo por la suscripción de un tenant.
 * externalRef debe ser único y estable (usar SubscriptionInvoice.invoice_number).
 */
async function enviarPrefactura({ externalRef, cliente, items, fechaLimitePago, moneda = 'COP' }) {
  const config = await getConfig();
  if (!config || !config.is_active) {
    throw new Error('La conexión con el Núcleo NCF no está activa (revisar Superadmin → Facturación Núcleo).');
  }

  const client = buildClient(config);
  if (!client) {
    throw new Error('Configuración NCF incompleta: falta ncf_base_url o ncf_api_key.');
  }

  const { data } = await client.post('/prefacturas', {
    external_ref: externalRef,
    cliente,
    items,
    fecha_limite_pago: fechaLimitePago,
    moneda,
  });

  return data; // { id, status, payment_link_url, rejection_reason }
}

/**
 * Verifica la firma HMAC-SHA256 de un webhook entrante del Núcleo
 * (header X-NCF-Signature). rawBody debe ser el JSON tal como llegó, sin
 * reserializar -- Express con `express.json({ verify })` debe guardarlo
 * crudo para que la firma coincida byte a byte (ver ncfWebhook.routes.js).
 */
async function verificarFirmaWebhook(rawBody, signatureHeader) {
  const config = await getConfig();
  if (!config?.ncf_webhook_secret) {
    logger.warn('[NCF] ncf_webhook_secret no configurado -- se omite verificación (inseguro, solo dev)');
    return true;
  }
  if (!signatureHeader) return false;

  const expected = crypto.createHmac('sha256', config.ncf_webhook_secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Trae la facturación REAL de Pitbox (plata cobrada de verdad vía el
 * Núcleo), agrupada por mes -- para reemplazar el estimado que hoy usa
 * /superadmin/analytics/overview.
 */
async function obtenerFacturacionMensual(meses = 12) {
  const config = await getConfig();
  const client = buildClient(config);
  if (!client) return null; // sin conexión configurada -- el caller decide el fallback

  const { data } = await client.get('/prefacturas/reportes/facturacion-mensual', { params: { meses } });
  return data.facturacion_por_mes;
}

module.exports = { getConfig, probarConexion, enviarPrefactura, verificarFirmaWebhook, obtenerFacturacionMensual };
