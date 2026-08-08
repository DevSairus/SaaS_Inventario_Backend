// backend/src/controllers/ensambladora/vehiculos.controller.js
const crypto = require('crypto');
const { VehiculoCache, EnsambladoraOrdenEntrega } = require('../../models');
const { consultarVehiculoPorVin, consultarVehiculoPorPlaca, validarDisponibilidadEnCore, VehiculoNoEncontradoError } = require('../../services/ensambladora/coreApiClient');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');
const logger = require('../../config/logger');

/**
 * Refleja (best-effort) un cambio puntual del vehículo en vehiculos_cache,
 * sin esperar al próximo forzar_online -- mismo criterio que
 * refrescarCacheEstado en ciclovida.controller.js.
 */
async function refrescarCache(vin, patch) {
  try {
    const cacheado = await VehiculoCache.findByPk(vin);
    if (cacheado) {
      await cacheado.update({ datos: { ...cacheado.datos, ...patch } });
    }
  } catch (error) {
    logger.warn('[Ensambladora] No se pudo refrescar vehiculos_cache', { vin, message: error.message });
  }
}

/**
 * GET /api/ensambladora/vehiculos/:vin
 * Operación NO crítica (ver contrato, sección 4: "para operaciones no
 * críticas el CSA lee del cache"). Lazy-fill: si no está en cache, se
 * consulta al Core y se guarda para la próxima vez. `?forzar_online=true`
 * fuerza a refrescar contra el Core aunque ya haya cache.
 */
async function buscarPorVin(req, res) {
  const { vin } = req.params;
  const forzarOnline = req.query.forzar_online === 'true';

  try {
    if (!forzarOnline) {
      const cacheado = await VehiculoCache.findByPk(vin);
      if (cacheado) {
        return res.json({
          success: true,
          data: cacheado.datos,
          fuente: 'cache',
          verificado_en_linea: cacheado.verificado_en_linea,
          ultima_sincronizacion: cacheado.ultima_sincronizacion,
        });
      }
    }

    const datos = await consultarVehiculoPorVin(req.tenant_id, vin);
    await VehiculoCache.upsert({
      vin,
      datos,
      ultima_sincronizacion: new Date(),
      verificado_en_linea: true,
    });

    res.json({ success: true, data: datos, fuente: 'core', verificado_en_linea: true, ultima_sincronizacion: new Date() });
  } catch (error) {
    if (error instanceof VehiculoNoEncontradoError) {
      return res.status(404).json({ success: false, code: 'vehiculo_no_encontrado', message: error.message });
    }
    logger.error('[Ensambladora] Error consultando vehículo', { vin, message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo consultar el vehículo en la Ensambladora' });
  }
}

/**
 * GET /api/ensambladora/vehiculos/buscar?placa=...
 * Segunda vía para encontrar el mismo vehículo que GET /vehiculos/:vin,
 * pensada para cuando el asesor tiene la placa a mano en vez del VIN (ver
 * requerimientos-pitbox-busqueda-por-placa.md). SIEMPRE en línea contra el
 * Core -- no existe un índice local por placa en vehiculos_cache (el cache
 * sigue indexado por vin, contrato sección 5), así que no hay de dónde
 * servir esto desde cache. El resultado sí se guarda en el cache (por vin,
 * que viaja en la respuesta) para que la próxima vez que se abra el
 * detalle de ese vehículo por VIN, la lectura cache-first de buscarPorVin
 * ya lo encuentre.
 */
async function buscarPorPlaca(req, res) {
  const { placa } = req.query;
  if (!placa) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'placa es obligatorio' });
  }

  try {
    const datos = await consultarVehiculoPorPlaca(req.tenant_id, placa);
    await VehiculoCache.upsert({
      vin: datos.vin,
      datos,
      ultima_sincronizacion: new Date(),
      verificado_en_linea: true,
    });

    res.json({ success: true, data: datos, fuente: 'core', verificado_en_linea: true, ultima_sincronizacion: new Date() });
  } catch (error) {
    if (error instanceof VehiculoNoEncontradoError) {
      return res.status(404).json({
        success: false,
        code: 'vehiculo_no_encontrado',
        message: 'No se encontró ningún vehículo con esa placa -- puede que aún no esté registrada en el catálogo',
      });
    }
    logger.error('[Ensambladora] Error consultando vehículo por placa', { placa, message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo consultar el vehículo en la Ensambladora' });
  }
}

/**
 * POST /api/ensambladora/vehiculos/:vin/matricular
 * body: { placa }
 * Informa al Core que el vehículo ya se matriculó y cuál es su placa (ver
 * requerimientos-pitbox-busqueda-por-placa.md, sección 3) -- evento propio
 * (`vehiculo.matriculado`), independiente de venta.creada, porque el
 * trámite de matrícula suele resolverse días o semanas después de la
 * venta. Sin tabla local -- igual que atenderRecall, el dato de placa vive
 * en el Core; Pitbox solo lo informa y lo refleja en su cache para que la
 * próxima consulta por VIN (o la búsqueda por placa) ya lo muestre.
 *
 * `entidad_id` del evento es un UUID nuevo por envío -- a diferencia de
 * venta/alistamiento/etc no hay una orden local cuyo id reusar acá.
 */
async function matricularVehiculo(req, res) {
  const { vin } = req.params;
  const { placa } = req.body || {};

  if (!placa) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'placa es obligatorio' });
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'vehiculo.matriculado',
    entidadTipo: 'vehiculo',
    entidadId: crypto.randomUUID(),
    payload: { vin, placa },
  });

  if (!envio.ok) {
    if (envio.status === 409) {
      return res.status(409).json({
        success: false,
        code: 'placa_duplicada',
        message: 'Esa placa ya está asignada a otro vehículo en la Ensambladora',
      });
    }
    logger.error('[Ensambladora] Error informando matrícula', { vin, message: envio.error?.message });
    return res.status(502).json({
      success: false,
      code: 'error_confirmando_con_core',
      message: 'No se pudo confirmar la matrícula con la Ensambladora',
      error_core: envio.error,
    });
  }

  await refrescarCache(vin, { placa });

  res.json({ success: true });
}

/**
 * POST /api/ensambladora/vehiculos/:vin/validar-disponibilidad
 * Operación CRÍTICA -- siempre en línea contra el Core, nunca desde cache
 * (contrato, sección 4). Si el Core no responde, se informa al llamador
 * para que la venta quede "pendiente de validar" en vez de confirmarse
 * sobre un cache potencialmente desactualizado (el flujo de venta en sí se
 * conecta en Fase 2).
 */
async function validarDisponibilidad(req, res) {
  const { vin } = req.params;

  try {
    const resultado = await validarDisponibilidadEnCore(req.tenant_id, vin);
    res.json({ success: true, ...resultado });
  } catch (error) {
    logger.error('[Ensambladora] Error validando disponibilidad', { vin, message: error.message });
    res.status(502).json({
      success: false,
      code: 'validacion_no_disponible',
      message: 'No se pudo validar la disponibilidad en línea contra la Ensambladora — no confirmar la venta todavía',
    });
  }
}

/**
 * GET /api/ensambladora/vehiculos/agenda-revisiones?forzar_online=true
 * "Agenda de revisiones pendientes" (roadmap Fase 3, front Pitbox). El Core
 * no expone un listado por CSA (su único /vehiculos/pendientes-revision es
 * de panel admin, protegido por requireAuth y filtrado por
 * ensambladora_id, no por CSA) -- así que se arma acá a partir de
 * ensambladora_ordenes_entrega (el 100% de los VIN que este tenant ha
 * entregado) y se consulta proxima_revision por vehículo, cache-first
 * igual que buscarPorVin, para no golpear el Core en cada carga de la
 * agenda. Si un VIN nunca se consultó individualmente todavía no tiene
 * cache -- se llena en el mismo request (lazy-fill), igual que
 * GET /vehiculos/:vin.
 *
 * `crearRevision` (ciclovida.controller.js) ya refresca el cache del VIN
 * apenas se registra una revisión, así que en el camino normal esto ya
 * viene al día. `forzar_online=true` es el escape manual del botón
 * "Actualizar" del frontend para el caso borde en que ese refresco puntual
 * haya fallado (ver refrescarCacheDesdeCorePorRevision, es best-effort).
 */
async function agendaRevisiones(req, res) {
  const forzarOnline = req.query.forzar_online === 'true';
  const entregas = await EnsambladoraOrdenEntrega.findAll({ attributes: ['vin'] });

  const resultados = await Promise.all(
    entregas.map(async ({ vin }) => {
      try {
        let cacheado = forzarOnline ? null : await VehiculoCache.findByPk(vin);
        if (!cacheado) {
          const datos = await consultarVehiculoPorVin(req.tenant_id, vin);
          await VehiculoCache.upsert({
            vin,
            datos,
            ultima_sincronizacion: new Date(),
            verificado_en_linea: true,
          });
          cacheado = await VehiculoCache.findByPk(vin);
        }
        return cacheado?.datos || null;
      } catch (error) {
        // Un VIN con error individual (ej. de baja en el Core, red caída)
        // no debe tumbar la agenda completa -- se omite y queda logueado.
        logger.warn('[Ensambladora] No se pudo resolver vehículo para la agenda de revisiones', { vin, message: error.message });
        return null;
      }
    })
  );

  const pendientes = resultados
    .filter((v) => v && v.proxima_revision?.vencida)
    .sort((a, b) => new Date(a.proxima_revision.fecha_programada || 0) - new Date(b.proxima_revision.fecha_programada || 0));

  res.json({ success: true, data: pendientes, total: pendientes.length });
}

/**
 * POST /api/ensambladora/vehiculos/:vin/recalls/:campanaId/atender
 * Sin tabla local -- a diferencia de venta/alistamiento/etc, acá no hay
 * nada que Pitbox necesite conservar más allá de haber avisado al Core
 * (el estado de verdad, "atendido"/"pendiente", vive en el Core y ya
 * viaja de vuelta en `recalls_pendientes` dentro de GET /vehiculos/{vin}).
 */
async function atenderRecall(req, res) {
  const { vin, campanaId } = req.params;

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'recall.atendido',
    entidadTipo: 'recall',
    entidadId: campanaId,
    payload: { campana_id: campanaId, vin },
  });

  if (!envio.ok) {
    logger.error('[Ensambladora] Error marcando recall atendido', { vin, campanaId, message: envio.error?.message });
    return res.status(502).json({
      success: false,
      code: 'error_confirmando_con_core',
      message: 'No se pudo confirmar con la Ensambladora que el recall quedó atendido',
      error_core: envio.error,
    });
  }

  res.json({ success: true });
}

module.exports = { buscarPorVin, buscarPorPlaca, matricularVehiculo, validarDisponibilidad, atenderRecall, agendaRevisiones };
