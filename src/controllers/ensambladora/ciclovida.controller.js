// backend/src/controllers/ensambladora/ciclovida.controller.js
const { EnsambladoraVenta, EnsambladoraOrdenAlistamiento, EnsambladoraOrdenEntrega, EnsambladoraOrdenRevision, VehiculoCache } = require('../../models');
const { validarDisponibilidadEnCore, consultarVehiculoPorVin } = require('../../services/ensambladora/coreApiClient');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');
const { registrarAuditoria } = require('../../services/ensambladora/auditLog');
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
 * A diferencia de refrescarCacheEstado (que solo pisa un campo puntual sin
 * volver a preguntarle nada al Core), `proxima_revision` es un cálculo que
 * vive enteramente del lado del Core (ver revisionCalculator.js allá) --
 * no hay campo local que "parchear", hay que volver a consultar. Sin esto,
 * el cache quedaba con el snapshot de "vencida: true" de ANTES de la
 * revisión hasta el próximo `forzar_online` manual -- que la Agenda de
 * revisiones nunca dispara (lee cache-first y solo llena si está vacío),
 * así que una revisión recién hecha seguía apareciendo como pendiente
 * indefinidamente.
 */
async function refrescarCacheDesdeCorePorRevision(tenantId, vin) {
  try {
    const datos = await consultarVehiculoPorVin(tenantId, vin);
    await VehiculoCache.upsert({ vin, datos, ultima_sincronizacion: new Date(), verificado_en_linea: true });
  } catch (error) {
    logger.warn('[Ensambladora] No se pudo refrescar vehiculos_cache tras registrar revisión', { vin, message: error.message });
  }
}

/**
 * POST /api/ensambladora/ventas
 * Valida disponibilidad EN LÍNEA contra el Core antes de crear nada local
 * (contrato, sección 4) -- evita crear una venta local que el Core después
 * va a rechazar por una carrera con otro CSA.
 */
async function crearVenta(req, res) {
  const { vin, cliente_documento, cliente_nombre, cliente_telefono, fecha_venta, precio, vendedor_documento } = req.body || {};

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
      precio: precio != null ? precio : null,
      vendedor_documento: vendedor_documento || null,
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
    payload: { vin, cliente_documento, cliente_nombre, cliente_telefono, fecha_venta, precio, vendedor_documento },
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

/** GET /api/ensambladora/alistamientos?vin=... -- listado local por VIN (ver listarPorVin de garantías, mismo criterio) */
async function listarAlistamientosPorVin(req, res) {
  const { vin } = req.query;
  if (!vin) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin es obligatorio' });
  }
  const ordenes = await EnsambladoraOrdenAlistamiento.findAll({ where: { vin }, order: [['createdAt', 'DESC']] });
  res.json({ success: true, data: ordenes });
}

/** GET /api/ensambladora/entregas?vin=... -- listado local por VIN */
async function listarEntregasPorVin(req, res) {
  const { vin } = req.query;
  if (!vin) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin es obligatorio' });
  }
  const ordenes = await EnsambladoraOrdenEntrega.findAll({ where: { vin }, order: [['createdAt', 'DESC']] });
  res.json({ success: true, data: ordenes });
}

/** POST /api/ensambladora/alistamientos */
async function crearAlistamiento(req, res) {
  const { vin, responsable, fecha, checklist, observaciones, tarifario_servicio_id, valor_mano_obra } = req.body || {};

  if (!vin || !fecha) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y fecha son obligatorios' });
  }

  let orden;
  try {
    orden = await EnsambladoraOrdenAlistamiento.create({
      vin,
      responsable: responsable || null,
      fecha,
      checklist: checklist || {},
      observaciones: observaciones || null,
      tarifario_servicio_id: tarifario_servicio_id || null,
      valor_mano_obra: valor_mano_obra != null ? valor_mano_obra : null,
      sync_estado: 'pendiente',
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, code: 'vin_ya_alistado_localmente', message: `Ya existe un alistamiento local para el VIN ${vin}` });
    }
    throw error;
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'alistamiento.completado',
    entidadTipo: 'alistamiento',
    entidadId: orden.id,
    payload: {
      vin,
      responsable,
      fecha,
      checklist,
      observaciones,
      tarifario_servicio_id: tarifario_servicio_id || null,
      valor_mano_obra: valor_mano_obra != null ? valor_mano_obra : null,
    },
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

  registrarAuditoria({
    entidad_tipo: 'alistamiento',
    entidad_id: orden.id,
    vin,
    accion: 'creado',
    usuario_id: req.user?.id,
    usuario_nombre: req.user?.email,
    detalle: { responsable },
  });

  res.status(201).json({ success: true, data: orden });
}

/** POST /api/ensambladora/entregas */
async function crearEntrega(req, res) {
  const { vin, fecha_entrega, recibido_por, evidencia_url } = req.body || {};

  if (!vin || !fecha_entrega) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y fecha_entrega son obligatorios' });
  }

  // Si vino archivo (multipart, campo "evidencia"), sube a Cloudinary y esa
  // URL manda sobre cualquier evidencia_url de texto que también haya
  // llegado en el body (mismo criterio que uploadPhotos de workshop).
  let evidenciaUrlFinal = evidencia_url || null;
  if (req.file) {
    try {
      const useCloudinary =
        process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET;

      if (useCloudinary) {
        const cloudinary = require('cloudinary').v2;
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key:    process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
        });
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: `ensambladora/entregas/${req.tenant_id}/${vin}`, resource_type: 'image' },
            (err, r) => (err ? reject(err) : resolve(r))
          );
          stream.end(req.file.buffer);
        });
        evidenciaUrlFinal = result.secure_url;
      } else {
        logger.warn('[Ensambladora] Cloudinary no configurado -- se ignora el archivo de evidencia, queda solo evidencia_url si vino', { vin });
      }
    } catch (error) {
      logger.error('[Ensambladora] Error subiendo evidencia de entrega', { vin, message: error.message });
      return res.status(502).json({ success: false, code: 'error_subiendo_evidencia', message: 'No se pudo subir la foto de evidencia' });
    }
  }

  let orden;
  try {
    orden = await EnsambladoraOrdenEntrega.create({
      vin,
      fecha_entrega,
      recibido_por: recibido_por || null,
      evidencia_url: evidenciaUrlFinal,
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
    payload: { vin, fecha_entrega, recibido_por, evidencia_url: evidenciaUrlFinal },
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

/**
 * POST /api/ensambladora/revisiones
 * `politica_id` viene de `proxima_revision.politica_id` en la respuesta de
 * GET /api/ensambladora/vehiculos/{vin} (Fase 3), o de cualquiera de las
 * políticas de la línea que devuelve GET /api/ensambladora/
 * politicas-mantenimiento?linea_id=... si el taller registra una revisión
 * fuera de secuencia -- el CSA nunca arma ese id a mano, siempre lo copia
 * de uno de esos dos listados.
 *
 * Resto de campos (checklist/mano de obra/piezas/observaciones) son el
 * detalle del formulario de mantenimiento -- todos opcionales, ver
 * requerimientos-pitbox-formulario-mantenimiento.md, sección 2. Si el
 * taller no usó piezas ni cobró mano de obra, se manda igual con esos
 * campos vacíos/omitidos (misma sección, nota de UX).
 */
async function crearRevision(req, res) {
  const {
    vin,
    politica_id,
    fecha_realizada,
    kilometraje_registrado,
    checklist,
    observaciones,
    tarifario_servicio_id,
    valor_mano_obra,
    piezas,
  } = req.body || {};

  if (!vin || !politica_id || !fecha_realizada) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin, politica_id y fecha_realizada son obligatorios' });
  }

  let orden;
  try {
    orden = await EnsambladoraOrdenRevision.create({
      vin,
      politica_id,
      fecha_realizada,
      kilometraje_registrado: kilometraje_registrado != null ? kilometraje_registrado : null,
      checklist: checklist || {},
      observaciones: observaciones || null,
      tarifario_servicio_id: tarifario_servicio_id || null,
      valor_mano_obra: valor_mano_obra != null ? valor_mano_obra : null,
      piezas: Array.isArray(piezas) ? piezas : [],
      sync_estado: 'pendiente',
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        success: false,
        code: 'revision_ya_registrada_localmente',
        message: 'Ya existe una revisión local para ese vehículo con esta política de mantenimiento',
      });
    }
    throw error;
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'revision.completada',
    entidadTipo: 'revision',
    entidadId: orden.id,
    payload: {
      vin,
      politica_id,
      fecha_realizada,
      kilometraje_registrado,
      checklist: checklist || {},
      observaciones: observaciones || null,
      tarifario_servicio_id: tarifario_servicio_id || null,
      valor_mano_obra: valor_mano_obra != null ? valor_mano_obra : null,
      piezas: Array.isArray(piezas) ? piezas : [],
    },
  });

  await orden.update({
    sync_estado: envio.ok ? 'confirmado' : 'error',
    evento_sync_id: envio.eventId,
    core_orden_revision_id: envio.ok ? envio.resultado?.orden_revision_id || null : null,
  });

  if (!envio.ok) {
    return res.status(502).json({
      success: false,
      code: 'revision_pendiente_de_sincronizar',
      message: 'La revisión quedó registrada localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: orden,
      error_core: envio.error,
    });
  }

  // El kilometraje/próxima revisión se recalcula en el Core -- se refresca
  // el cache acá mismo (ver refrescarCacheDesdeCorePorRevision) en vez de
  // esperar a un forzar_online manual que en la práctica nunca llega.
  await refrescarCacheDesdeCorePorRevision(req.tenant_id, vin);

  res.status(201).json({ success: true, data: orden });
}

module.exports = {
  crearVenta,
  crearAlistamiento,
  listarAlistamientosPorVin,
  crearEntrega,
  listarEntregasPorVin,
  crearRevision,
};