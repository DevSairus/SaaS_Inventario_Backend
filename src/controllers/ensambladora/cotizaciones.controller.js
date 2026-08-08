// backend/src/controllers/ensambladora/cotizaciones.controller.js
const { EnsambladoraCotizacion, Tenant } = require('../../models');
const { sendEventToCore } = require('../../services/ensambladora/syncOutboundClient');
const { generarCotizacionPDF } = require('../../services/ensambladora/cotizacionPdfService');
const logger = require('../../config/logger');

/**
 * POST /api/ensambladora/cotizaciones
 * JSON: { linea_id*, linea_nombre, vin, tecnico_documento, cliente_nombre,
 *         cliente_documento, cliente_telefono, fecha*, items*: [{concepto, valor}] }
 * `linea_id` es el UUID real del Core (viene de GET /ensambladora/lineas,
 * pass-through -- mismo criterio que `politica_id` en crearRevision, no
 * hace falta un código corto intermedio como con las piezas). El Core
 * recalcula `total` a partir de `items` en vez de confiar en el que se
 * manda acá (ver handleCotizacionCreada, eventoSyncHandlers.js del Core).
 */
async function crearCotizacion(req, res) {
  const { linea_id, linea_nombre, vin, tecnico_documento, cliente_nombre, cliente_documento, cliente_telefono, fecha, items } =
    req.body || {};

  if (!linea_id || !fecha || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, code: 'payload_invalido', message: 'linea_id, fecha y al menos un item son obligatorios' });
  }

  const total = items.reduce((suma, item) => suma + (Number(item.valor) || 0), 0);

  const cotizacion = await EnsambladoraCotizacion.create({
    linea_id,
    linea_nombre: linea_nombre || null,
    vin: vin || null,
    tecnico_documento: tecnico_documento || null,
    cliente_nombre: cliente_nombre || null,
    cliente_documento: cliente_documento || null,
    cliente_telefono: cliente_telefono || null,
    fecha,
    items,
    total,
    sync_estado: 'pendiente',
  });

  const envio = await sendEventToCore({
    tenantId: req.tenant_id,
    tipoEvento: 'cotizacion.creada',
    entidadTipo: 'cotizacion',
    entidadId: cotizacion.id,
    payload: { linea_id, vin, tecnico_documento, cliente_nombre, cliente_documento, cliente_telefono, fecha, items },
  });

  await cotizacion.update({
    sync_estado: envio.ok ? 'confirmado' : 'error',
    evento_sync_id: envio.eventId,
    core_cotizacion_id: envio.ok ? envio.resultado?.cotizacion_id || null : null,
  });

  if (!envio.ok) {
    logger.error('[Ensambladora] Error sincronizando cotización', { id: cotizacion.id, message: envio.error?.message });
    // Igual que ventas/alistamientos/etc: queda registrada localmente (y el
    // PDF ya se le puede entregar al cliente sin depender de esto) aunque
    // el Core todavía no la confirmó -- se reintenta desde el panel de
    // monitoreo (Fase 8).
    return res.status(502).json({
      success: false,
      code: 'cotizacion_pendiente_de_sincronizar',
      message: 'La cotización quedó registrada localmente pero no se pudo confirmar con la Ensambladora todavía',
      data: cotizacion,
      error_core: envio.error,
    });
  }

  res.status(201).json({ success: true, data: cotizacion });
}

/** GET /api/ensambladora/cotizaciones/:id/pdf -- documento para el cliente. */
async function generarPdf(req, res) {
  const cotizacion = await EnsambladoraCotizacion.findByPk(req.params.id);
  if (!cotizacion) {
    return res.status(404).json({ success: false, code: 'no_encontrado', message: 'No existe una cotización con ese id' });
  }
  // Datos del CSA para la cabecera del PDF (logo, nombre, contacto) --
  // mismo criterio que el PDF de OT (workOrders.controller.js).
  const tenant = await Tenant.findByPk(req.tenant_id, {
    attributes: ['company_name', 'phone', 'email', 'address', 'logo_url', 'tax_id'],
  });
  await generarCotizacionPDF(res, { cotizacion, lineaNombre: cotizacion.linea_nombre, tenant });
}

module.exports = { crearCotizacion, generarPdf };
