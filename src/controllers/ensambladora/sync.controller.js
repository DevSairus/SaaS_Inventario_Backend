// backend/src/controllers/ensambladora/sync.controller.js
const { EnsambladoraEventoSync } = require('../../models');
const { reenviarEventoExistente } = require('../../services/ensambladora/syncOutboundClient');
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
 * Panel de monitoreo (Fase 8) -- filtros: estado, tipo_evento, direccion, revisado.
 */
async function listEvents(req, res) {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.estado) where.estado = req.query.estado;
    if (req.query.tipo_evento) where.tipo_evento = req.query.tipo_evento;
    if (req.query.direccion) where.direccion = req.query.direccion;
    if (req.query.revisado != null) where.revisado = req.query.revisado === 'true';

    const eventos = await EnsambladoraEventoSync.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: 100,
    });
    res.json({ success: true, data: eventos });
  } catch (error) {
    logger.error('[Ensambladora Sync] Error listando eventos', { message: error.message });
    res.status(500).json({ success: false, message: 'Error listando eventos de sincronización' });
  }
}

/**
 * POST /api/ensambladora/sync/events/:id/reintentar
 * Solo para eventos SALIENTES en estado "error" -- ver
 * syncOutboundClient.js#reenviarEventoExistente para la limitación
 * importante (solo sirve de verdad si el evento nunca llegó al Core).
 */
async function reintentarEvento(req, res) {
  const evento = await EnsambladoraEventoSync.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
  if (!evento) {
    return res.status(404).json({ success: false, code: 'evento_no_encontrado', message: 'No existe un evento con ese id' });
  }
  if (evento.direccion !== 'saliente') {
    return res.status(400).json({ success: false, code: 'direccion_no_soportada', message: 'Solo se pueden reintentar eventos salientes' });
  }
  if (evento.estado !== 'error') {
    return res.status(409).json({ success: false, code: 'estado_invalido', message: `El evento está en estado "${evento.estado}", no en error` });
  }

  const resultado = await reenviarEventoExistente(evento);

  if (!resultado.ok) {
    return res.status(502).json({
      success: false,
      code: 'reintento_fallido',
      message: 'El reintento no se pudo confirmar con la Ensambladora',
      data: evento,
      error_core: resultado.error,
    });
  }

  res.json({ success: true, data: evento });
}

/** POST /api/ensambladora/sync/events/:id/marcar-revisado -- body: { revisado_por } */
async function marcarRevisado(req, res) {
  const { revisado_por } = req.body || {};
  if (!revisado_por) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'revisado_por es obligatorio' });
  }

  const evento = await EnsambladoraEventoSync.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
  if (!evento) {
    return res.status(404).json({ success: false, code: 'evento_no_encontrado', message: 'No existe un evento con ese id' });
  }

  await evento.update({ revisado: true, revisado_por, revisado_en: new Date() });
  res.json({ success: true, data: evento });
}

module.exports = { receiveInbound, listEvents, reintentarEvento, marcarRevisado };
