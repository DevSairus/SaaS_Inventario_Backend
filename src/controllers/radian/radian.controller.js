// backend/src/controllers/radian/radian.controller.js
/**
 * Endpoints:
 *   POST /api/radian/purchases/:id/acuse             → Emite el evento 030 (Acuse de recibo)
 *   POST /api/radian/purchases/:id/recibo            → Emite el evento 032 (Recibo del bien/servicio) — fija el plazo de 3 días hábiles
 *   POST /api/radian/purchases/:id/aceptacion        → Emite el evento 033 (Aceptación expresa)
 *   POST /api/radian/purchases/:id/reclamo           → Emite el evento 031 (Reclamo) — body: { reason_code, reason_text }
 *   GET  /api/radian/purchases/:id/events            → Timeline de eventos RADIAN de una compra
 *   POST /api/radian/sales/:id/received-event        → Registra un 032/033/031 recibido del cliente — body: { event_code, note }
 *   POST /api/radian/sales/:id/aceptacion-tacita      → Emite el evento 034 (Aceptación tácita) — body: { declarant_type }
 *   GET  /api/radian/sales/:id/events                → Timeline de eventos RADIAN de una venta
 *   GET  /api/radian/pending                          → Avisos activos (plazos por vencer/vencidos, 034 disponible)
 *
 *   Fase 4 (requiere factura inscrita — ver radianService.js):
 *   POST /api/radian/sales/:id/inscripcion            → Emite el 036 (Inscripción como título valor)
 *   POST /api/radian/sales/:id/endoso                 → Emite 037/038/039 — body: { tipo: 'propiedad'|'garantia'|'procuracion', holder_nit, holder_name, terms }
 *   POST /api/radian/sales/:id/cancelar-endoso        → Emite el 040 — body: { reason }
 *   POST /api/radian/sales/:id/limitacion             → Emite el 041 — body: { reason }
 *   POST /api/radian/sales/:id/terminar-limitacion    → Emite el 042
 *   POST /api/radian/sales/:id/mandato                → Emite el 043 — body: { mandatario_nit, mandatario_name }
 *   POST /api/radian/sales/:id/terminar-mandato       → Emite el 044
 *   POST /api/radian/sales/:id/pago                   → Emite el 045 — body: { amount, payment_date, payment_method }
 *   POST /api/radian/sales/:id/informe-pago           → Emite el 046 — body: { note }
 */
const logger = require('../../config/logger');
const { RadianEvent, RadianAlert } = require('../../models');
const radianService = require('../../services/radian/radianService');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Construye el mensaje de resultado usando el motivo real devuelto por la DIAN
// (result.message viene de StatusDescription/StatusMessage del XML de respuesta),
// en vez de un texto genérico que oculta la razón del rechazo.
const resultMessage = (result, label, code) => {
  if (result.accepted) return `${label} (${code}) aceptado por la DIAN`;
  const motivo = result.message ? result.message : 'sin motivo especificado por la DIAN';
  return `Evento ${code} rechazado o pendiente: ${motivo}`;
};

const emitAcuse = async (req, res) => {
  try {
    const result = await radianService.emitAcuse030(req.params.id, req.tenant_id, req.user.id);
    ok(res, { data: result, message: resultMessage(result, 'Acuse de recibo', '030') });
  } catch (e) {
    logger.error('[RADIAN] Error emitAcuse:', e);
    fail(res, e.message || 'Error al emitir el evento 030', 500);
  }
};

const emitRecibo = async (req, res) => {
  try {
    const result = await radianService.emitRecibo032(req.params.id, req.tenant_id, req.user.id);
    ok(res, { data: result, message: resultMessage(result, 'Recibo del bien/servicio', '032') });
  } catch (e) {
    logger.error('[RADIAN] Error emitRecibo:', e);
    fail(res, e.message || 'Error al emitir el evento 032', 500);
  }
};

const emitAceptacion = async (req, res) => {
  try {
    const result = await radianService.emitAceptacion033(req.params.id, req.tenant_id, req.user.id);
    ok(res, { data: result, message: resultMessage(result, 'Aceptación expresa', '033') });
  } catch (e) {
    logger.error('[RADIAN] Error emitAceptacion:', e);
    fail(res, e.message || 'Error al emitir el evento 033', 500);
  }
};

const emitReclamo = async (req, res) => {
  try {
    const { reason_code, reason_text } = req.body;
    if (!reason_text) return fail(res, 'El motivo del reclamo es obligatorio');

    const result = await radianService.emitReclamo031(req.params.id, req.tenant_id, req.user.id, {
      claimReasonCode: reason_code,
      claimReasonText: reason_text,
    });
    ok(res, { data: result, message: resultMessage(result, 'Reclamo', '031') });
  } catch (e) {
    logger.error('[RADIAN] Error emitReclamo:', e);
    fail(res, e.message || 'Error al emitir el evento 031', 500);
  }
};

const getEvents = async (req, res) => {
  try {
    const events = await RadianEvent.findAll({
      where: { tenant_id: req.tenant_id, purchase_id: req.params.id },
      order: [['created_at', 'DESC']],
      attributes: { exclude: ['request_xml', 'signed_xml', 'dian_response_raw'] },
    });
    ok(res, { data: events });
  } catch (e) {
    logger.error('[RADIAN] Error getEvents:', e);
    fail(res, 'Error al consultar los eventos RADIAN', 500);
  }
};

// ─── Ventas ─────────────────────────────────────────────────────────────

const recordSaleEvent = async (req, res) => {
  try {
    const { event_code, note } = req.body;
    if (!['032', '033', '031'].includes(event_code)) {
      return fail(res, 'event_code debe ser 032, 033 o 031');
    }
    const result = await radianService.recordSaleReceivedEvent(event_code, req.params.id, req.tenant_id, req.user.id, { note });
    ok(res, { data: result, message: `Evento ${event_code} registrado` });
  } catch (e) {
    logger.error('[RADIAN] Error recordSaleEvent:', e);
    fail(res, e.message || 'Error al registrar el evento', 500);
  }
};

const emitTacita = async (req, res) => {
  try {
    const declarantType = req.body?.declarant_type || 'direct';
    const result = await radianService.emitAceptacionTacita034(req.params.id, req.tenant_id, req.user.id, declarantType);
    ok(res, { data: result, message: resultMessage(result, 'Aceptación tácita', '034') });
  } catch (e) {
    logger.error('[RADIAN] Error emitTacita:', e);
    fail(res, e.message || 'Error al emitir el evento 034', 500);
  }
};

const getSaleEvents = async (req, res) => {
  try {
    const events = await RadianEvent.findAll({
      where: { tenant_id: req.tenant_id, sale_id: req.params.id },
      order: [['created_at', 'DESC']],
      attributes: { exclude: ['request_xml', 'signed_xml', 'dian_response_raw'] },
    });
    ok(res, { data: events });
  } catch (e) {
    logger.error('[RADIAN] Error getSaleEvents:', e);
    fail(res, 'Error al consultar los eventos RADIAN', 500);
  }
};

// ─── Fase 4 ─────────────────────────────────────────────────────────────

const emitInscripcion = async (req, res) => {
  try {
    const result = await radianService.emitInscripcion036(req.params.id, req.tenant_id, req.user.id);
    ok(res, { data: result, message: resultMessage(result, 'Inscripción', '036') });
  } catch (e) {
    logger.error('[RADIAN] Error emitInscripcion:', e);
    fail(res, e.message || 'Error al emitir el evento 036', 500);
  }
};

const emitEndoso = async (req, res) => {
  try {
    const { tipo, holder_nit, holder_name, terms } = req.body;
    const result = await radianService.emitEndoso(tipo, req.params.id, req.tenant_id, req.user.id, {
      holderNit: holder_nit, holderName: holder_name, terms,
    });
    ok(res, {
      data: result,
      message: result.accepted
        ? `Endoso en ${tipo} aceptado por la DIAN`
        : `Endoso rechazado o pendiente: ${result.message || 'sin motivo especificado por la DIAN'}`,
    });
  } catch (e) {
    logger.error('[RADIAN] Error emitEndoso:', e);
    fail(res, e.message || 'Error al emitir el endoso', 500);
  }
};

const emitCancelacionEndoso = async (req, res) => {
  try {
    const result = await radianService.emitCancelacionEndoso040(req.params.id, req.tenant_id, req.user.id, { reason: req.body?.reason });
    ok(res, { data: result, message: resultMessage(result, 'Cancelación del endoso', '040') });
  } catch (e) {
    logger.error('[RADIAN] Error emitCancelacionEndoso:', e);
    fail(res, e.message || 'Error al cancelar el endoso', 500);
  }
};

const emitLimitacion = async (req, res) => {
  try {
    const result = await radianService.emitLimitacion041(req.params.id, req.tenant_id, req.user.id, { reason: req.body?.reason });
    ok(res, { data: result, message: resultMessage(result, 'Limitación de circulación', '041') });
  } catch (e) {
    logger.error('[RADIAN] Error emitLimitacion:', e);
    fail(res, e.message || 'Error al emitir la limitación de circulación', 500);
  }
};

const emitTerminarLimitacion = async (req, res) => {
  try {
    const result = await radianService.emitTerminacionLimitacion042(req.params.id, req.tenant_id, req.user.id);
    ok(res, { data: result, message: resultMessage(result, 'Terminación de la limitación', '042') });
  } catch (e) {
    logger.error('[RADIAN] Error emitTerminarLimitacion:', e);
    fail(res, e.message || 'Error al terminar la limitación de circulación', 500);
  }
};

const emitMandato = async (req, res) => {
  try {
    const { mandatario_nit, mandatario_name } = req.body;
    const result = await radianService.emitMandato043(req.params.id, req.tenant_id, req.user.id, {
      mandatarioNit: mandatario_nit, mandatarioName: mandatario_name,
    });
    ok(res, { data: result, message: resultMessage(result, 'Mandato', '043') });
  } catch (e) {
    logger.error('[RADIAN] Error emitMandato:', e);
    fail(res, e.message || 'Error al emitir el mandato', 500);
  }
};

const emitTerminarMandato = async (req, res) => {
  try {
    const result = await radianService.emitTerminacionMandato044(req.params.id, req.tenant_id, req.user.id);
    ok(res, { data: result, message: resultMessage(result, 'Terminación del mandato', '044') });
  } catch (e) {
    logger.error('[RADIAN] Error emitTerminarMandato:', e);
    fail(res, e.message || 'Error al terminar el mandato', 500);
  }
};

const emitPago = async (req, res) => {
  try {
    const { amount, payment_date, payment_method } = req.body;
    const result = await radianService.emitPago045(req.params.id, req.tenant_id, req.user.id, {
      amount, paymentDate: payment_date, paymentMethod: payment_method,
    });
    ok(res, { data: result, message: resultMessage(result, 'Pago', '045') });
  } catch (e) {
    logger.error('[RADIAN] Error emitPago:', e);
    fail(res, e.message || 'Error al emitir el pago', 500);
  }
};

const emitInformePago = async (req, res) => {
  try {
    const result = await radianService.emitInformePago046(req.params.id, req.tenant_id, req.user.id, { note: req.body?.note });
    ok(res, { data: result, message: resultMessage(result, 'Informe para el pago', '046') });
  } catch (e) {
    logger.error('[RADIAN] Error emitInformePago:', e);
    fail(res, e.message || 'Error al emitir el informe para el pago', 500);
  }
};

// ─── Pendientes (job radian-deadlines, ver services/radian/radianDeadlinesJob.js) ─

const getPending = async (req, res) => {
  try {
    const alerts = await RadianAlert.findAll({
      where: { tenant_id: req.tenant_id, status: 'active' },
      order: [['deadline_at', 'ASC']],
    });
    ok(res, { data: alerts });
  } catch (e) {
    logger.error('[RADIAN] Error getPending:', e);
    fail(res, 'Error al consultar los pendientes RADIAN', 500);
  }
};

module.exports = {
  emitAcuse, emitRecibo, emitAceptacion, emitReclamo, getEvents,
  recordSaleEvent, emitTacita, getSaleEvents,
  emitInscripcion, emitEndoso, emitCancelacionEndoso,
  emitLimitacion, emitTerminarLimitacion,
  emitMandato, emitTerminarMandato,
  emitPago, emitInformePago,
  getPending,
};
