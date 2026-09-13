// backend/src/services/payroll/payrollEmailService.js
/**
 * Envía al empleado el PDF de su comprobante de pago de nómina, una vez
 * aceptado por la DIAN — mismo patrón que dianEmailService.js#
 * sendElectronicInvoiceEmail para facturas: no lanza, quien invoque debe
 * tratar el error como "no bloqueante" (se llama vía setImmediate desde
 * payrollPeriodEmissionService.js#emitirDocumentoEmpleado, después de que
 * la transacción del documento ya se confirmó — un problema de correo no
 * debe hacer parecer que la nómina no se emitió a la DIAN).
 */
'use strict';

const logger = require('../../config/logger');
const emailService = require('../emailService');
const { generatePayrollDocumentPDFBuffer } = require('../dian/payrollPdfService');

function employeeFullName(employee) {
  return [employee.first_name, employee.first_surname].filter(Boolean).join(' ').trim();
}

function buildEmailHtml(payrollDocument, employee, tenant) {
  const empresa = tenant.dian_config?.company_name || tenant.company_name || 'Nómina electrónica';
  return `
    <p>Hola ${employeeFullName(employee) || 'colaborador(a)'},</p>
    <p>Adjunto encontrará su comprobante de pago de nómina <strong>${payrollDocument.payroll_document_number}</strong>,
       aceptado por la DIAN.</p>
    <p><strong>CUNE:</strong> ${payrollDocument.cune}</p>
    <p>Puede validar este documento en el portal de la DIAN usando el CUNE anterior.</p>
    <hr>
    <p><small>${empresa}</small></p>
  `;
}

/**
 * @returns {{ sent: boolean, reason?: string }} — nunca lanza; un fallo de
 * correo se reporta como { sent: false }, no como excepción, para que el
 * caller (fire-and-forget) solo tenga que loguear y seguir.
 */
async function sendPayrollDocumentEmail(payrollDocument, employee, period, tenant) {
  if (!employee.email || !employee.email.trim()) {
    logger.warn(`[Nómina] Documento ${payrollDocument.payroll_document_number}: empleado ${employee.id} sin correo registrado, no se envía comprobante.`);
    return { sent: false, reason: 'no_employee_email' };
  }
  if (!payrollDocument.cune) {
    // No debería pasar (solo se llama tras accepted=true), pero defensivo:
    // sin CUNE el PDF no representa un documento realmente aceptado.
    logger.warn(`[Nómina] Documento ${payrollDocument.payroll_document_number}: sin CUNE todavía, no se envía comprobante.`);
    return { sent: false, reason: 'no_cune' };
  }

  const pdfBuffer = await generatePayrollDocumentPDFBuffer(payrollDocument, employee, period, tenant);
  const baseName = payrollDocument.payroll_document_number || payrollDocument.id;

  await emailService.sendEmail({
    to: employee.email.trim(),
    subject: `Comprobante de pago de nómina ${payrollDocument.payroll_document_number}`,
    html: buildEmailHtml(payrollDocument, employee, tenant),
    attachments: [{ filename: `${baseName}.pdf`, content: pdfBuffer }],
  });

  logger.info(`[Nómina] Comprobante ${payrollDocument.payroll_document_number} enviado a ${employee.email}`);
  return { sent: true };
}

module.exports = { sendPayrollDocumentEmail };
