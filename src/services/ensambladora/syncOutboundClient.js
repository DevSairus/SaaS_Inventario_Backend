// backend/src/services/ensambladora/syncOutboundClient.js
//
// Envía un evento firmado del tenant hacia POST /sync/inbound del Core
// Ensambladora. Fase 0 lo deja listo con un event_id de prueba; el disparo
// real por negocio (venta.creada, alistamiento.completado, etc.) se conecta
// desde la Fase 2 en adelante, cuando existan esas entidades.
//
// No implementa reintentos con backoff todavía (mejora posterior, Fase 8) --
// registra el resultado inmediato en el outbox (ensambladora_eventos_sync).
const crypto = require('crypto');
const { EnsambladoraSyncCredential, EnsambladoraEventoSync } = require('../../models');
const logger = require('../../config/logger');

async function sendEventToCore({ tenantId, tipoEvento, entidadTipo, entidadId, payload }) {
  const credential = await EnsambladoraSyncCredential.findOne({ where: { tenant_id: tenantId, estado: 'activo' } });
  if (!credential) {
    throw new Error(`El tenant ${tenantId} no tiene credenciales activas de sincronización con la Ensambladora`);
  }

  const coreUrl = process.env.ENSAMBLADORA_CORE_URL;
  if (!coreUrl) {
    throw new Error('ENSAMBLADORA_CORE_URL no está configurado');
  }

  const eventId = crypto.randomUUID();
  const body = {
    event_id: eventId,
    tipo_evento: tipoEvento,
    version: '1.0',
    origen: 'csa_pdv',
    csa_pdv_id: credential.csa_pdv_id_externo || null,
    ocurrido_en: new Date().toISOString(),
    entidad_tipo: entidadTipo,
    entidad_id: entidadId,
    payload: payload || {},
  };

  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', credential.hmac_secret).update(rawBody).digest('hex');

  const outboxRow = await EnsambladoraEventoSync.create({
    id: eventId,
    tenant_id: tenantId,
    direccion: 'saliente',
    tipo_evento: tipoEvento,
    entidad_tipo: entidadTipo || null,
    entidad_id: entidadId || null,
    payload: body.payload,
    origen: 'csa_pdv',
    estado: 'pendiente',
    ocurrido_en: body.ocurrido_en,
  });

  try {
    const response = await fetch(`${coreUrl.replace(/\/$/, '')}/api/sync/inbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': credential.api_key,
        'X-Signature': signature,
      },
      body: rawBody,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      await outboxRow.update({
        estado: 'error',
        intentos: outboxRow.intentos + 1,
        ultimo_error: `HTTP ${response.status}: ${errorBody?.error?.message || 'sin detalle'}`,
      });
      return { ok: false, eventId, status: response.status, error: errorBody?.error || null };
    }

    const body = await response.json().catch(() => ({}));
    await outboxRow.update({ estado: 'confirmado', intentos: outboxRow.intentos + 1, procesado_en: new Date() });
    return { ok: true, eventId, status: response.status, resultado: body?.resultado || null };
  } catch (error) {
    await outboxRow.update({ estado: 'error', intentos: outboxRow.intentos + 1, ultimo_error: error.message });
    logger.error('[Ensambladora Sync] Error de red enviando al Core', { tenantId, tipoEvento, message: error.message });
    return { ok: false, eventId, status: null, error: { code: 'error_red', message: error.message } };
  }
}

/**
 * Reintento manual (Fase 8) de un evento SALIENTE que quedó en estado
 * "error" -- reusa el MISMO event_id (no genera uno nuevo). Esto solo
 * sirve de verdad si el evento nunca llegó a registrarse en el Core (ej.
 * falla de red): la idempotencia del Core por event_id hace que, si el
 * Core ya tiene una fila con ese id (porque sí llegó, pero con error de
 * negocio), simplemente devuelva el estado viejo sin volver a correr el
 * manejador -- para ESE caso, el reintento real se hace desde el panel del
 * Core (ver eventosSyncMonitor.controller.js allá), no desde acá.
 */
async function reenviarEventoExistente(eventoLocal) {
  const credential = await EnsambladoraSyncCredential.findOne({ where: { tenant_id: eventoLocal.tenant_id, estado: 'activo' } });
  if (!credential) {
    throw new Error(`El tenant ${eventoLocal.tenant_id} no tiene credenciales activas de sincronización con la Ensambladora`);
  }

  const coreUrl = process.env.ENSAMBLADORA_CORE_URL;
  if (!coreUrl) {
    throw new Error('ENSAMBLADORA_CORE_URL no está configurado');
  }

  const body = {
    event_id: eventoLocal.id,
    tipo_evento: eventoLocal.tipo_evento,
    version: eventoLocal.version || '1.0',
    origen: 'csa_pdv',
    csa_pdv_id: credential.csa_pdv_id_externo || null,
    ocurrido_en: (eventoLocal.ocurrido_en || eventoLocal.created_at).toISOString(),
    entidad_tipo: eventoLocal.entidad_tipo,
    entidad_id: eventoLocal.entidad_id,
    payload: eventoLocal.payload || {},
  };

  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', credential.hmac_secret).update(rawBody).digest('hex');

  try {
    const response = await fetch(`${coreUrl.replace(/\/$/, '')}/api/sync/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': credential.api_key, 'X-Signature': signature },
      body: rawBody,
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
      await eventoLocal.update({
        estado: 'error',
        intentos: eventoLocal.intentos + 1,
        ultimo_error: `HTTP ${response.status}: ${responseBody?.error?.message || 'sin detalle'}`,
      });
      return { ok: false, status: response.status, error: responseBody?.error || null };
    }

    await eventoLocal.update({ estado: 'confirmado', intentos: eventoLocal.intentos + 1, ultimo_error: null, procesado_en: new Date() });
    return { ok: true, status: response.status, resultado: responseBody?.resultado || null };
  } catch (error) {
    await eventoLocal.update({ estado: 'error', intentos: eventoLocal.intentos + 1, ultimo_error: error.message });
    return { ok: false, status: null, error: { code: 'error_red', message: error.message } };
  }
}

module.exports = { sendEventToCore, reenviarEventoExistente };
