// backend/src/services/payroll/payrollAdjustmentService.js
/**
 * Orquesta la Nota de Ajuste (NominaIndividualDeAjuste — Reemplazar/Eliminar)
 * de un PayrollDocument ya aceptado por la DIAN.
 *
 * Patrón: igual que SupportDocumentAdjustment (ver
 * dian.controller.js#createSupportDocumentAdjustment +
 * dianService.js#sendSupportDocumentAdjustmentToDian) — el controlador crea
 * la fila PayrollDocumentAdjustment en estado 'pending' dentro de su propia
 * transacción y la comitea de inmediato; el envío real a la DIAN ocurre
 * fire-and-forget (setImmediate) llamando a sendPayrollAdjustmentToDian()
 * de este archivo, que firma, envía, y actualiza esa misma fila. Se eligió
 * este patrón (en vez del síncrono de payrollPeriodEmissionService.js) para
 * ser consistente con el resto de notas de ajuste del proyecto — una nota
 * de ajuste es una acción puntual sobre 1 documento, no un lote de N
 * empleados como la emisión de un periodo.
 */
'use strict';

const { generateSoftwareSecurityCode } = require('@dian-kit/core');
const {
  sequelize, PayrollDocumentAdjustment, DianEvent,
} = require('../../models');
const logger = require('../../config/logger');
const { formatFechaCol } = require('../dian/payrollXmlBuilder');
const { submitPayrollAdjustmentDocument } = require('../dian/payrollDianAdapter');
const { getNextConsecutive, extractDianConfig } = require('../dian/dianService');
const { getNovedadesParaLiquidacion } = require('./payrollPeriodEmissionService');
const { liquidarEmpleado } = require('./payrollService');

/**
 * Resuelve el predecesor que debe llevar la Nota de Ajuste.
 *
 * El numeral 1 del Anexo Técnico es explícito: un documento puede
 * corregirse "tantas veces como correcciones se requieran", y es "la
 * última nota de ajuste... validada, la que sirva como soporte". Por eso
 * el predecesor NO es siempre el PayrollDocument original: si ya existe
 * una nota de ajuste ACEPTADA anterior sobre este mismo documento, esa es
 * la que se está corrigiendo/eliminando ahora, no el original.
 *
 * @param {PayrollDocument} payrollDocument
 * @returns {{ numeroPred: string, cunePred: string, fechaGenPred: string }}
 */
async function resolvePredecessor(payrollDocument) {
  const lastAccepted = await PayrollDocumentAdjustment.findOne({
    where: { payroll_document_id: payrollDocument.id, dian_status: 'accepted' },
    order: [['created_at', 'DESC']],
  });

  if (lastAccepted) {
    return {
      numeroPred: lastAccepted.adjustment_number,
      cunePred: lastAccepted.cune,
      fechaGenPred: formatFechaCol(lastAccepted.dian_accepted_at || lastAccepted.created_at),
    };
  }

  return {
    numeroPred: payrollDocument.payroll_document_number,
    cunePred: payrollDocument.cune,
    fechaGenPred: formatFechaCol(payrollDocument.dian_accepted_at || payrollDocument.created_at),
  };
}

/**
 * Arma la `liquidation` que se incluye en el ajuste.
 *
 * - 'replace': se vuelve a liquidar al empleado con las novedades que
 *   existan HOY para ese periodo — el caso de uso típico de un Reemplazar
 *   es justamente que se corrigió/agregó una novedad después de haber
 *   emitido el documento original, y ahora hay que reflejarla.
 * - 'delete': el Anexo (numeral 13.1, tabla de QR de la opción Eliminar)
 *   fija ValDev/ValDed/ValTol en 0.00 — un Eliminar no repite conceptos,
 *   solo identifica qué se invalida. Igual necesita softwareSecurityCode
 *   (ver nota en payrollXmlBuilder.js).
 */
async function buildLiquidationForAdjustment({
  tenant, employee, period, adjustmentType, numeroDocumento,
}) {
  const cfg = extractDianConfig(tenant);
  const softwareSecurityCode = generateSoftwareSecurityCode(cfg.software_id_nomina, cfg.software_pin_nomina, numeroDocumento);

  if (adjustmentType === 'delete') {
    return {
      devengados: {},
      deducciones: {},
      devengadosTotal: 0,
      deduccionesTotal: 0,
      tiempoLaboradoDias: 0,
      softwareSecurityCode,
      paymentDates: [],
    };
  }

  const { diasNoRemunerados, novedadesDian } = await getNovedadesParaLiquidacion(tenant.id, employee.id, period.id);
  return liquidarEmpleado({
    employee, period, novedades: novedadesDian, diasNoRemunerados, softwareSecurityCode,
  });
}

/**
 * Firma, envía y persiste el resultado de una Nota de Ajuste ya creada
 * (fila PayrollDocumentAdjustment en estado 'pending' o 'rejected' — este
 * mismo método sirve tanto para el envío inicial como para un reintento,
 * igual que sendSupportDocumentAdjustmentToDian()).
 *
 * @param {PayrollDocumentAdjustment} adjustment
 * @param {PayrollDocument} payrollDocument - con employee/period incluidos
 * @param {Tenant} tenant
 */
async function sendPayrollAdjustmentToDian(adjustment, payrollDocument, tenant) {
  const { employee, period } = payrollDocument;
  const cfg = extractDianConfig(tenant);
  const isTest = cfg.environment !== 'production';

  try {
    await adjustment.update({ dian_status: 'sending' });

    // Reintento (adjustment.adjustment_number ya asignado de un intento
    // anterior): se reutiliza el mismo consecutivo — igual criterio que
    // getNextConsecutive() aplica para reintentar una venta/documento que
    // ya tenía número asignado, no se debe consumir numeración nueva solo
    // porque el intento anterior falló.
    const t = await sequelize.transaction();
    let rawNumbering;
    try {
      rawNumbering = await getNextConsecutive(
        tenant.id, payrollDocument.branch_id, isTest, t, adjustment.adjustment_number, 'payroll_adjustment',
      );
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
    const numbering = { prefix: rawNumbering.resolution.prefix, consecutivo: rawNumbering.consecutive };
    const numeroDocumento = rawNumbering.invoiceNumber;

    const predecessor = await resolvePredecessor(payrollDocument);
    const liquidation = await buildLiquidationForAdjustment({
      tenant, employee, period, adjustmentType: adjustment.adjustment_type, numeroDocumento,
    });

    const result = await submitPayrollAdjustmentDocument({
      tenant, employee, period, liquidation, numbering,
      adjustmentType: adjustment.adjustment_type,
      predecessor,
    });

    const accepted = result.dianResponse?.isValid || result.dianResponse?.statusCode === '00';
    const dianStatus = accepted ? 'accepted' : 'rejected';

    await adjustment.update({
      adjustment_number: numeroDocumento,
      cune: result.cune,
      xml_content: result.xml,
      snapshot_liquidation: adjustment.adjustment_type === 'replace' ? liquidation : null,
      devengados_total: result.devengadosTotal,
      deducciones_total: result.deduccionesTotal,
      comprobante_total: result.comprobanteTotal,
      dian_status: dianStatus,
      dian_response: result.dianResponse,
      dian_sent_at: new Date(),
      dian_accepted_at: accepted ? new Date() : null,
      dian_error_message: accepted ? null : (result.dianResponse?.statusMessage || 'Rechazado por la DIAN'),
    });

    await DianEvent.create({
      tenant_id: tenant.id,
      payroll_document_id: payrollDocument.id,
      event_type: 'SendNominaSync',
      document_type: 'PayrollAdjustment',
      invoice_number: numeroDocumento,
      cufe: result.cune,
      request_xml: result.xml,
      response_raw: result.dianResponse?.raw,
      status: dianStatus,
      error_message: accepted ? null : result.dianResponse?.statusMessage,
      is_test: isTest,
    });

    logger.info(`[Nómina-Ajuste-DIAN] ${numeroDocumento} (documento ${payrollDocument.id}, tipo ${adjustment.adjustment_type}) — Status: ${dianStatus} | CUNE: ${result.cune?.substring(0, 16)}...`);

    return { accepted, adjustment };
  } catch (error) {
    logger.error(`[Nómina-Ajuste-DIAN] Error enviando Nota de Ajuste (${adjustment.id}, documento ${payrollDocument.id}):`, error);
    await adjustment.update({ dian_status: 'rejected', dian_error_message: error.message });

    try {
      await DianEvent.create({
        tenant_id: tenant.id,
        payroll_document_id: payrollDocument.id,
        event_type: 'SendNominaSync',
        document_type: 'PayrollAdjustment',
        status: 'error',
        error_message: error.message,
        is_test: isTest,
      });
    } catch (e2) {
      logger.error('[Nómina-Ajuste-DIAN] Error guardando evento de error de nota de ajuste:', e2);
    }

    return { accepted: false, adjustment, error: error.message };
  }
}

module.exports = {
  resolvePredecessor,
  buildLiquidationForAdjustment,
  sendPayrollAdjustmentToDian,
};
