// backend/src/controllers/ensambladora/garantias.controller.js
const { EnsambladoraOrdenGarantia } = require('../../models');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');
const { consultarGarantias, consultarGarantia } = require('../../services/ensambladora/coreApiClient');
const { registrarAuditoria } = require('../../services/ensambladora/auditLog');
const logger = require('../../config/logger');

/**
 * Sube (si hay archivos y Cloudinary está configurado) la evidencia de cada
 * item de garantía -- usado tanto al radicar (crearGarantia) como al
 * corregir y reenviar (reenviarGarantia). `req.files` trae campos
 * `evidencia_<idx>` (índice dentro de `items`), igual convención en ambos
 * casos. Devuelve `items` con `evidencia_url` completado donde aplique;
 * lanza `ErrorSubidaEvidencia` si falla la subida.
 */
async function subirEvidencias(req, items, carpeta) {
  if (!req.files || req.files.length === 0) return items;

  const useCloudinary =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;

  if (!useCloudinary) {
    logger.warn('[Ensambladora] Cloudinary no configurado -- se ignoran las fotos de evidencia de garantía', { carpeta });
    return items;
  }

  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  const resultado = [...items];
  for (const file of req.files) {
    const match = /^evidencia_(\d+)$/.exec(file.fieldname);
    if (!match) continue;
    const idx = Number(match[1]);
    if (!resultado[idx]) continue;

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: carpeta, resource_type: 'image' },
        (err, r) => (err ? reject(err) : resolve(r))
      );
      stream.end(file.buffer);
    });
    resultado[idx] = { ...resultado[idx], evidencia_url: uploaded.secure_url };
  }

  return resultado;
}

/**
 * GET /api/ensambladora/garantias/todas
 * Pass-through al Core (mismo criterio que listarLiquidaciones) -- trae el
 * estado real de negocio de cada garantía radicada por este CSA, a
 * diferencia de listarPorVin que solo lee el modelo local (sin estado real).
 */
async function listarTodas(req, res) {
  try {
    const garantias = await consultarGarantias(req.tenant_id);
    res.json({ success: true, data: garantias });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando garantías', { message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudieron consultar las garantías' });
  }
}

/**
 * GET /api/ensambladora/garantias?vin=...
 * Listado LOCAL de garantías radicadas para un VIN -- necesario porque
 * GET /vehiculos/:vin (Core) devuelve las garantías con el id del Core
 * (OrdenGarantia.id), y cerrarGarantia necesita el id LOCAL
 * (ensambladora_ordenes_garantia.id). El front cruza ambos por
 * core_orden_garantia_id para saber qué botón "cerrar" habilitar.
 */
async function listarPorVin(req, res) {
  const { vin } = req.query;
  if (!vin) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin es obligatorio' });
  }

  const ordenes = await EnsambladoraOrdenGarantia.findAll({
    where: { vin },
    order: [['createdAt', 'DESC']],
  });

  res.json({ success: true, data: ordenes });
}

/**
 * POST /api/ensambladora/garantias
 * JSON: { vin, tecnico_documento, items: [{ pieza_codigo, codigo_falla, cantidad, evidencia_url }] }
 * Multipart (con fotos): mismos campos, pero `items` viaja como JSON string
 * (sin evidencia_url) y cada foto llega en un campo `evidencia_<index>`
 * (índice dentro del array items) -- así no hay que forzar una foto por
 * item ni depender del orden de los archivos.
 * `pieza_codigo` es el código corto del catálogo de piezas de la
 * Ensambladora (lo resuelve el Core al procesar el evento) -- ver
 * eventoSyncHandlers.js#handleGarantiaRadicada del lado Core.
 */
async function crearGarantia(req, res) {
  const isMultipart = req.is('multipart/form-data');
  const vin = req.body?.vin;
  const tecnico_documento = req.body?.tecnico_documento;
  let items;

  try {
    items = isMultipart ? JSON.parse(req.body?.items || '[]') : (req.body?.items || []);
  } catch (error) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'items debe ser un JSON válido' });
  }

  if (!vin || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'vin y al menos un item son obligatorios' });
  }

  // Subir evidencia por item (si hay archivos) antes de crear nada -- igual
  // criterio que crearEntrega: si falla la subida, no se radica nada a
  // medias.
  try {
    items = await subirEvidencias(req, items, `ensambladora/garantias/${req.tenant_id}/${vin}`);
  } catch (error) {
    logger.error('[Ensambladora] Error subiendo evidencia de garantía', { vin, message: error.message });
    return res.status(502).json({ success: false, code: 'error_subiendo_evidencia', message: 'No se pudo subir una de las fotos de evidencia' });
  }

  const orden = await EnsambladoraOrdenGarantia.create({
    vin,
    tecnico_documento: tecnico_documento || null,
    items,
    sync_estado: 'pendiente',
  });

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'garantia.radicada',
    entidadTipo: 'garantia',
    entidadId: orden.id,
    payload: { vin, tecnico_documento, items },
  });

  await orden.update({
    sync_estado: envio.ok ? 'confirmado' : 'error',
    evento_sync_id: envio.eventId,
    core_orden_garantia_id: envio.ok ? envio.resultado?.orden_garantia_id || null : null,
  });

  if (!envio.ok) {
    return res.status(502).json({
      success: false,
      code: 'garantia_pendiente_de_sincronizar',
      message: 'La garantía quedó registrada localmente pero no se pudo radicar con la Ensambladora todavía',
      data: orden,
      error_core: envio.error,
    });
  }

  registrarAuditoria({
    entidad_tipo: 'garantia',
    entidad_id: orden.id,
    vin,
    accion: 'radicada',
    usuario_id: req.user?.id,
    usuario_nombre: req.user?.email,
    detalle: { tecnico_documento, items_count: items.length },
  });

  res.status(201).json({ success: true, data: orden });
}

/**
 * POST /api/ensambladora/garantias/:id/cerrar
 * `:id` es el id LOCAL de ensambladora_ordenes_garantia -- el evento hacia
 * el Core usa `core_orden_garantia_id`, que ya se guardó al radicar.
 */
async function cerrarGarantia(req, res) {
  const { id } = req.params;
  const { fecha_cierre } = req.body || {};

  if (!fecha_cierre) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'fecha_cierre es obligatorio' });
  }

  const orden = await EnsambladoraOrdenGarantia.findByPk(id);
  if (!orden) {
    return res.status(404).json({ success: false, code: 'garantia_no_encontrada', message: 'No existe una garantía local con ese id' });
  }
  if (!orden.core_orden_garantia_id) {
    return res.status(409).json({
      success: false,
      code: 'garantia_no_confirmada',
      message: 'Esta garantía todavía no se confirmó con la Ensambladora -- no se puede cerrar',
    });
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'garantia.cerrada',
    entidadTipo: 'garantia',
    entidadId: orden.id,
    payload: { orden_garantia_id: orden.core_orden_garantia_id, fecha_cierre },
  });

  if (!envio.ok) {
    logger.error('[Ensambladora] Error cerrando garantía en el Core', { id, message: envio.error?.message });
    return res.status(502).json({
      success: false,
      code: 'cierre_no_confirmado',
      message: 'No se pudo confirmar el cierre con la Ensambladora',
      error_core: envio.error,
    });
  }

  await orden.update({ cerrada: true, fecha_cierre });

  registrarAuditoria({
    entidad_tipo: 'garantia',
    entidad_id: orden.id,
    vin: orden.vin,
    accion: 'cerrada',
    usuario_id: req.user?.id,
    usuario_nombre: req.user?.email,
    detalle: { fecha_cierre },
  });

  res.json({ success: true, data: orden });
}

/**
 * GET /api/ensambladora/garantias/:id
 * `:id` es el id LOCAL -- se resuelve a `core_orden_garantia_id` y se hace
 * pass-through al Core para traer el detalle real (estado, observaciones,
 * items con su `id`) que necesita el formulario de reenvío para prellenarse.
 */
async function obtenerDetalle(req, res) {
  const { id } = req.params;

  const orden = await EnsambladoraOrdenGarantia.findByPk(id);
  if (!orden) {
    return res.status(404).json({ success: false, code: 'garantia_no_encontrada', message: 'No existe una garantía local con ese id' });
  }
  if (!orden.core_orden_garantia_id) {
    return res.status(409).json({
      success: false,
      code: 'garantia_no_confirmada',
      message: 'Esta garantía todavía no se confirmó con la Ensambladora',
    });
  }

  try {
    const detalle = await consultarGarantia(req.tenant_id, orden.core_orden_garantia_id);
    res.json({ success: true, data: detalle });
  } catch (error) {
    logger.error('[Ensambladora] Error consultando detalle de garantía', { id, message: error.message });
    res.status(502).json({ success: false, code: 'error_consultando_core', message: 'No se pudo consultar la garantía' });
  }
}

/**
 * POST /api/ensambladora/garantias/:id/reenviar
 * `:id` es el id LOCAL. JSON o multipart (mismas convenciones que
 * crearGarantia): `items` (opcional) trae `{ id? , pieza_codigo, codigo_falla,
 * cantidad, evidencia_url }` -- con `id` corrige un renglón existente, sin
 * `id` agrega uno nuevo. `items_eliminar` (opcional) es un array de ids de
 * items existentes a borrar. Solo tiene efecto si la orden está `devuelta`
 * en el Core (lo valida garantia.reenviada, ver eventoSyncHandlers.js).
 */
async function reenviarGarantia(req, res) {
  const { id } = req.params;
  const isMultipart = req.is('multipart/form-data');
  let items;
  let items_eliminar;

  try {
    items = isMultipart ? JSON.parse(req.body?.items || '[]') : (req.body?.items || []);
    items_eliminar = isMultipart ? JSON.parse(req.body?.items_eliminar || '[]') : (req.body?.items_eliminar || []);
  } catch (error) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'items/items_eliminar deben ser JSON válido' });
  }

  const orden = await EnsambladoraOrdenGarantia.findByPk(id);
  if (!orden) {
    return res.status(404).json({ success: false, code: 'garantia_no_encontrada', message: 'No existe una garantía local con ese id' });
  }
  if (!orden.core_orden_garantia_id) {
    return res.status(409).json({
      success: false,
      code: 'garantia_no_confirmada',
      message: 'Esta garantía todavía no se confirmó con la Ensambladora -- no se puede reenviar',
    });
  }

  try {
    items = await subirEvidencias(req, items, `ensambladora/garantias/${req.tenant_id}/${orden.vin}`);
  } catch (error) {
    logger.error('[Ensambladora] Error subiendo evidencia de garantía', { id, message: error.message });
    return res.status(502).json({ success: false, code: 'error_subiendo_evidencia', message: 'No se pudo subir una de las fotos de evidencia' });
  }

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'garantia.reenviada',
    entidadTipo: 'garantia',
    entidadId: orden.id,
    payload: { orden_garantia_id: orden.core_orden_garantia_id, items, items_eliminar },
  });

  if (!envio.ok) {
    logger.error('[Ensambladora] Error reenviando garantía al Core', { id, message: envio.error?.message });
    return res.status(502).json({
      success: false,
      code: 'reenvio_no_confirmado',
      message: envio.error?.message || 'No se pudo confirmar el reenvío con la Ensambladora',
      error_core: envio.error,
    });
  }

  // Reenviar solo tiene efecto cuando el Core devolvió la garantía (ver
  // comentario del handler) -- esta es la señal local confiable de que hubo
  // una devolución que se está corrigiendo, para efectos de auditoría.
  registrarAuditoria({
    entidad_tipo: 'garantia',
    entidad_id: orden.id,
    vin: orden.vin,
    accion: 'reenviada_tras_devolucion',
    usuario_id: req.user?.id,
    usuario_nombre: req.user?.email,
    detalle: { items_count: items.length, items_eliminar_count: items_eliminar.length },
  });

  res.json({ success: true, data: envio.resultado });
}

module.exports = { crearGarantia, cerrarGarantia, listarPorVin, listarTodas, obtenerDetalle, reenviarGarantia };
