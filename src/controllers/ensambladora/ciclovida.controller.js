// backend/src/controllers/ensambladora/ciclovida.controller.js
const { EnsambladoraVenta, EnsambladoraOrdenAlistamiento, EnsambladoraOrdenEntrega, VehiculoCache } = require('../../models');
const { validarDisponibilidadEnCore } = require('../../services/ensambladora/coreApiClient');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');
const logger = require('../../config/logger');

/**
 * Refresca (best-effort) el cache local tras un cambio de estado en el Core,
 * para que la próxima lectura de GET /vehiculos/{vin} no muestre un estado
 * viejo hasta el próximo `forzar_online`. No es crítico si falla -- el cache
 * es solo para operaciones no críticas (contrato, sección 4).
 */
async function refrescarCacheEstado(vin, estado) {
  try {
    const cacheado = await VehiculoCache.findByPk(vin);
    if (cacheado) {
      await cacheado.update({ datos: { ...cacheado.datos, estado } });
    }
  } catch (error) {
    logger.warn('[Ensambladora] No se pudo refrescar vehiculos_cache tras evento', { vin, message: error.message });
  }
}

/**
 * POST /api/ensambladora/ventas
 * Valida disponibilidad EN LÍNEA contra el Core antes de crear nada local
 * (contrato, sección 4) -- evita crear una venta local que el Core después
 * va a rechazar por una carrera con otro CSA.
 */
async function crearVenta(req, res) {
  const { vin, cliente_documento, cliente_nombre, cliente_telefono, fecha_venta, precio } = req.body || {};

  if (!vin || !fecha_venta) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y fecha_venta son obligatorios' });
  }

  try {
    const disponibilidad = await validarDisponibilidadEnCore(req.tenant_id, vin);
    if (!disponibilidad.disponible) {
      return res.status(409).json({
        success: false,
        code: 'vehiculo_no_disponible',
        message: `El vehículo no está disponible para la venta (${disponibilidad.motivo || 'motivo desconocido'})`,
      });
    }
  } catch (error) {
    logger.error('[Ensambladora] No se pudo validar disponibilidad en línea', { vin, message: error.message });
    return res.status(502).json({
      success: false,
      code: 'validacion_no_disponible',
      message: 'No se pudo validar la disponibilidad en línea contra la Ensambladora -- no se confirmó la venta',
    });
  }

  let venta;
  try {
    venta = await EnsambladoraVenta.create({
      vin,
      cliente_documento: cliente_documento || null,
      cliente_nombre: cliente_nombre || null,
      cliente_telefono: cliente_telefono || null,
      fecha_venta,
      precio: precio || null,
      sync_estado: 'pendiente',
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, code: 'vin_ya_vendido_localmente', message: `Ya existe una venta local para el VIN ${vin}` });
    }
    throw error;
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'venta.creada',
    entidadTipo: 'venta',
    entidadId: venta.id,
    payload: { vin, cliente_documento, cliente_nombre, cliente_telefono, fecha_venta, precio },
  });

  await venta.update({ sync_estado: envio.ok ? 'confirmado' : 'error', evento_sync_id: envio.eventId });

  if (!envio.ok) {
    // La venta queda registrada localmente pero "pendiente de validar" del
    // lado del Core -- el reintento manual se conecta en Fase 8 (panel de
    // monitoreo); por ahora el error queda visible en
    // ensambladora_eventos_sync para revisión.
    return res.status(502).json({
      success: false,
      code: 'venta_pendiente_de_sincronizar',
      message: 'La venta quedó registrada localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: venta,
      error_core: envio.error,
    });
  }

  await refrescarCacheEstado(vin, 'vendido');

  res.status(201).json({ success: true, data: venta });
}

/** POST /api/ensambladora/alistamientos */
async function crearAlistamiento(req, res) {
  const { vin, responsable, fecha, checklist, observaciones } = req.body || {};

  if (!vin || !fecha) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y fecha son obligatorios' });
  }

  const orden = await EnsambladoraOrdenAlistamiento.create({
    vin,
    responsable: responsable || null,
    fecha,
    checklist: checklist || {},
    observaciones: observaciones || null,
    sync_estado: 'pendiente',
  });

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'alistamiento.completado',
    entidadTipo: 'alistamiento',
    entidadId: orden.id,
    payload: { vin, responsable, fecha, checklist, observaciones },
  });

  await orden.update({ sync_estado: envio.ok ? 'confirmado' : 'error', evento_sync_id: envio.eventId });

  if (!envio.ok) {
    return res.status(502).json({
      success: false,
      code: 'alistamiento_pendiente_de_sincronizar',
      message: 'El alistamiento quedó registrado localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: orden,
      error_core: envio.error,
    });
  }

  res.status(201).json({ success: true, data: orden });
}

/** POST /api/ensambladora/entregas */
async function crearEntrega(req, res) {
  const { vin, fecha_entrega, recibido_por, evidencia_url } = req.body || {};

  if (!vin || !fecha_entrega) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y fecha_entrega son obligatorios' });
  }

  let orden;
  try {
    orden = await EnsambladoraOrdenEntrega.create({
      vin,
      fecha_entrega,
      recibido_por: recibido_por || null,
      evidencia_url: evidencia_url || null,
      sync_estado: 'pendiente',
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, code: 'vin_ya_entregado_localmente', message: `Ya existe una entrega local para el VIN ${vin}` });
    }
    throw error;
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'entrega.completada',
    entidadTipo: 'entrega',
    entidadId: orden.id,
    payload: { vin, fecha_entrega, recibido_por, evidencia_url },
  });

  await orden.update({ sync_estado: envio.ok ? 'confirmado' : 'error', evento_sync_id: envio.eventId });

  if (!envio.ok) {
    return res.status(502).json({
      success: false,
      code: 'entrega_pendiente_de_sincronizar',
      message: 'La entrega quedó registrada localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: orden,
      error_core: envio.error,
    });
  }

  await refrescarCacheEstado(vin, 'en_garantia');

  res.status(201).json({ success: true, data: orden });
}

module.exports = { crearVenta, crearAlistamiento, crearEntrega };
