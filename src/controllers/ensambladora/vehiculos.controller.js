// backend/src/controllers/ensambladora/vehiculos.controller.js
const { VehiculoCache } = require('../../models');
const { consultarVehiculoPorVin, validarDisponibilidadEnCore, VehiculoNoEncontradoError } = require('../../services/ensambladora/coreApiClient');
const logger = require('../../config/logger');

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

module.exports = { buscarPorVin, validarDisponibilidad };
