// backend/src/services/whatsappDelivery.js
//
// Único camino de salida de WhatsApp hacia clientes. Con WhatsApp Pitbox
// operativo (Cloud API o demo) el mensaje sale por ahí y queda en el chat
// del cliente; si no está conectado o Meta lo rechaza (p. ej. ventana de
// 24 h cerrada sin plantilla), se devuelve un enlace wa.me para que el
// asesor lo envíe desde su celular. Todo va amarrado al tenant que llama.
const logger = require('../config/logger');
const { buildWaLink } = require('./whatsappService');
const { normalizeWhatsAppPhone } = require('../utils/customerWhatsappPhone');

const FALLBACK = Object.freeze({
  NOT_CONNECTED: 'not_connected',
  WINDOW_CLOSED: 'window_closed',
  ERROR: 'error',
});

function fallbackReasonOf(err) {
  if (err.code === 'WA_WINDOW_CLOSED') return FALLBACK.WINDOW_CLOSED;
  if (err.code === 'WA_NOT_CONNECTED') return FALLBACK.NOT_CONNECTED;
  return FALLBACK.ERROR;
}

/**
 * @param {object}  p
 * @param {string}  p.tenantId
 * @param {string}  p.to          Número del cliente (se normaliza a E.164 sin "+").
 * @param {string}  p.body        Texto libre (y texto del wa.me).
 * @param {{name: string, language?: string, components?: object[]}} [p.template]
 *        Plantilla aprobada: se usa en vez del texto cuando hay conexión real
 *        (en demo no hay Meta, así que va el texto).
 * @param {object}  [p.status]     getWhatsAppStatus ya cargado (lotes/cron).
 * @param {boolean} [p.allowWaLink=true]  false = sin wa.me: el error se lanza
 *        con `fallbackReason` (envíos automáticos que nadie puede abrir a mano).
 * @returns {Promise<{channel: 'cloud_api', conversation_id: string, phone: string}
 *   | {channel: 'wa_me', waLink: string, reason: string, phone: string}>}
 */
async function deliverWhatsApp({
  tenantId,
  to,
  body,
  template = null,
  userId = null,
  source = 'api',
  status = null,
  allowWaLink = true,
}) {
  if (!tenantId) throw new Error('deliverWhatsApp requiere tenantId');
  const phone = normalizeWhatsAppPhone(to);
  if (!phone) {
    const err = new Error('El cliente no tiene número de WhatsApp registrado.');
    err.status = 400;
    throw err;
  }

  // Carga diferida: los controladores importan este módulo y no deben
  // arrastrar los modelos de WhatsApp al importarse.
  const waCloud = require('./whatsappCloud.service');
  let reason = FALLBACK.NOT_CONNECTED;
  let wa = status;
  if (!wa) {
    try {
      wa = await waCloud.getWhatsAppStatus(tenantId);
    } catch (err) {
      logger.warn(`[WhatsApp] tenant=${tenantId} sin estado de conexión: ${err.message}`);
      reason = FALLBACK.ERROR;
      wa = { operational: false };
    }
  }
  if (wa.operational) {
    try {
      const sent = template?.name && !wa.demo_mode
        ? await waCloud.sendTemplateFromTenant({
          tenantId,
          to: phone,
          templateName: template.name,
          language: template.language || 'es',
          components: template.components || [],
          userId,
          source,
        })
        : await waCloud.sendTextFromTenant({ tenantId, to: phone, body, userId, source });
      return { channel: 'cloud_api', conversation_id: sent.conversation_id, phone };
    } catch (err) {
      reason = fallbackReasonOf(err);
      logger.warn(`[WhatsApp] tenant=${tenantId} no salió por Cloud API (${reason}): ${err.message}`);
      if (!allowWaLink) {
        err.fallbackReason = reason;
        throw err;
      }
    }
  } else if (!allowWaLink) {
    const err = new Error('WhatsApp no está conectado');
    err.status = 400;
    err.code = 'WA_NOT_CONNECTED';
    err.fallbackReason = reason;
    throw err;
  }

  return { channel: 'wa_me', waLink: buildWaLink(phone, body), reason, phone };
}

/** Componente `body` de una plantilla a partir de sus variables {{1}}, {{2}}… en orden. */
function bodyParams(values) {
  return { type: 'body', parameters: values.map((text) => ({ type: 'text', text: String(text) })) };
}

/** Forma común de la respuesta HTTP: `waLink` + `fallback_reason` solo si cayó a wa.me. */
function waResponse(sent) {
  return sent.channel === 'cloud_api'
    ? { channel: sent.channel, conversation_id: sent.conversation_id }
    : { channel: sent.channel, waLink: sent.waLink, fallback_reason: sent.reason };
}

module.exports = { deliverWhatsApp, waResponse, bodyParams, FALLBACK };
