// backend/src/controllers/ensambladora/sync.controller.js
const { EnsambladoraEventoSync } = require('../../models');
const logger = require('../../config/logger');

/**
 * POST /api/webhooks/ensambladora/sync/inbound
 * Recibe un evento del Core Ensambladora (ver verifySyncAuth). Fase 0: solo
 * registra el evento en el inbox con idempotencia por event_id -- el
 * procesamiento de negocio por tipo_evento (vehiculo.creado, etc.) se agrega
 * en las fases correspondientes del roadmap.
 */
async function receiveInbound(req, res) {
  try {
    const { event_id, tipo_evento, version, entidad_tipo, entidad_id, ocurrido_en, payload } = req.body || {};

    if (!event_id || !tipo_evento) {
      return res.status(400).json({ success: false, code: 'payload_invalido', message: 'event_id y tipo_evento son obligatorios' });
    }

    // Idempotencia: si ya se procesó este event_id, se responde confirmado
    // sin duplicar efectos.
    const existente = await EnsambladoraEventoSync.findByPk(event_id);
    if (existente) {
      return res.json({ event_id, estado: 'confirmado' });
    }

    await EnsambladoraEventoSync.create({
      id: event_id,
      tenant_id: req.tenant_id,
      direccion: 'entrante',
      tipo_evento,
      version: version || '1.0',
      entidad_tipo: entidad_tipo || null,
      entidad_id: entidad_id || null,
      payload: payload || {},
      origen: 'ensambladora',
      estado: 'confirmado',
      ocurrido_en: ocurrido_en || new Date(),
      procesado_en: new Date(),
    });

    logger.info('[Ensambladora Sync] Evento entrante registrado', {
      event_id,
      tipo_evento,
      tenant_id: req.tenant_id,
    });

    res.json({ event_id, estado: 'confirmado' });
  } catch (error) {
    logger.error('[Ensambladora Sync] Error procesando evento entrante', { message: error.message });
    res.status(500).json({ success: false, message: 'Error registrando el evento' });
  }
}

/**
 * GET /api/ensambladora/sync/events (autenticado, gated por requireModule)
 * Versión mínima del panel de monitoreo (Fase 8 lo formaliza) -- útil desde
 * ya para verificar en Fase 0 que los eventos de prueba quedaron registrados.
 */
async function listEvents(req, res) {
  try {
    const eventos = await EnsambladoraEventoSync.findAll({
      where: { tenant_id: req.tenant_id },
      order: [['created_at', 'DESC']],
      limit: 50,
    });
    res.json({ success: true, data: eventos });
  } catch (error) {
    logger.error('[Ensambladora Sync] Error listando eventos', { message: error.message });
    res.status(500).json({ success: false, message: 'Error listando eventos de sincronización' });
  }
}

module.exports = { receiveInbound, listEvents };
