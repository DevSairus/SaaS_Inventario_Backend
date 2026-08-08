// backend/src/controllers/ensambladora/liquidaciones.controller.js
//
// Sin tabla local -- a diferencia de ventas/alistamiento/entrega/revisión/
// garantía, esta plata la debe la Ensambladora, no el CSA: no hay nada que
// el CSA "cree" acá, solo consulta lo que el Core ya generó. Por eso es un
// simple pass-through, sin cache ni sync_estado.
//
// Si más adelante el volumen lo justifica, se le puede agregar una cache
// de solo lectura (mismo patrón que vehiculos_cache) para no pegarle al
// Core en cada consulta -- no se hizo acá para no agregar complejidad sin
// un problema real que la justifique todavía.
const {
  consultarLiquidaciones,
  consultarLiquidacion,
  consultarTarifarioVigente,
  consultarBoletines,
  consultarPoliticasMantenimiento,
  consultarCatalogoPiezas,
  consultarMarcas,
  consultarLineas,
} = require('../../services/ensambladora/coreApiClient');
const logger = require('../../config/logger');

async function listarLiquidaciones(req, res) {
  try {
    const liquidaciones = await consultarLiquidaciones(req.tenant_id);
    res.json({ success: true, data: liquidaciones });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando liquidaciones', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudieron consultar las liquidaciones' });
  }
}

async function obtenerLiquidacion(req, res) {
  try {
    const liquidacion = await consultarLiquidacion(req.tenant_id, req.params.id);
    res.json({ success: true, data: liquidacion });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando liquidación', { id: req.params.id, message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo consultar la liquidación' });
  }
}

async function tarifarioVigente(req, res) {
  const { marca_id } = req.query;
  if (!marca_id) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'marca_id es obligatorio' });
  }
  try {
    const tarifas = await consultarTarifarioVigente(req.tenant_id, marca_id);
    res.json({ success: true, data: tarifas });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando tarifario', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo consultar el tarifario' });
  }
}

async function listarBoletines(req, res) {
  const { marca_id } = req.query;
  if (!marca_id) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'marca_id es obligatorio' });
  }
  try {
    const boletines = await consultarBoletines(req.tenant_id, marca_id);
    res.json({ success: true, data: boletines });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando boletines', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudieron consultar los boletines' });
  }
}

/**
 * GET /api/ensambladora/politicas-mantenimiento?linea_id=...
 * Pass-through al Core -- ver consultarPoliticasMantenimiento. Sirve para
 * poblar el selector completo de "política/revisión" del formulario de
 * mantenimiento (requerimientos-pitbox-formulario-mantenimiento.md, 1.1bis).
 */
async function politicasMantenimiento(req, res) {
  const { linea_id } = req.query;
  if (!linea_id) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'linea_id es obligatorio' });
  }
  try {
    const politicas = await consultarPoliticasMantenimiento(req.tenant_id, linea_id);
    res.json({ success: true, data: politicas });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando políticas de mantenimiento', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudieron consultar las políticas de mantenimiento' });
  }
}

/**
 * GET /api/ensambladora/catalogo-piezas?marca_id=...&linea_id=...
 * Pass-through al Core -- ver consultarCatalogoPiezas. Sirve para el
 * multi-selector de "piezas usadas" del formulario de mantenimiento (mismo
 * documento, sección 1.3) y del formulario de garantías. `linea_id` es
 * opcional -- solo referencia para elegir un código válido, el Core es
 * quien revalida al procesar revision.completada/garantia.radicada.
 */
async function catalogoPiezas(req, res) {
  const { marca_id, linea_id } = req.query;
  if (!marca_id) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'marca_id es obligatorio' });
  }
  try {
    const piezas = await consultarCatalogoPiezas(req.tenant_id, marca_id, linea_id);
    res.json({ success: true, data: piezas });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando catálogo de piezas', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo consultar el catálogo de piezas' });
  }
}

/**
 * GET /api/ensambladora/marcas -- pass-through al Core. Selector de marca
 * para "Cotizar" (CotizarPage.jsx), sin partir de un vehículo/VIN.
 */
async function listarMarcas(req, res) {
  try {
    const marcas = await consultarMarcas(req.tenant_id);
    res.json({ success: true, data: marcas });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando marcas', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudieron consultar las marcas' });
  }
}

/**
 * GET /api/ensambladora/lineas?marca_id=... -- pass-through al Core, con
 * `precio_lista` incluido (autofill al cotizar).
 */
async function listarLineas(req, res) {
  const { marca_id } = req.query;
  if (!marca_id) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'marca_id es obligatorio' });
  }
  try {
    const lineas = await consultarLineas(req.tenant_id, marca_id);
    res.json({ success: true, data: lineas });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando líneas', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudieron consultar las líneas' });
  }
}

module.exports = {
  listarLiquidaciones,
  obtenerLiquidacion,
  tarifarioVigente,
  listarBoletines,
  politicasMantenimiento,
  catalogoPiezas,
  listarMarcas,
  listarLineas,
};
