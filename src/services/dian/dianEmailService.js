// backend/src/services/dian/dianEmailService.js
/**
 * Entrega al comprador del PDF (representación gráfica con CUFE/QR) +
 * XML firmado en un .zip — obligatorio para todo documento electrónico
 * aceptado por la DIAN (Resolución 000042 de 2020, num. 12: el facturador
 * debe entregar al adquirente la representación gráfica y el XML).
 */
'use strict';

const AdmZip = require('adm-zip');
const logger = require('../../config/logger');
const emailService = require('../emailService');
const { generateSalePDFBuffer } = require('../pdfService');

function buildZip({ pdfBuffer, signedXml, baseName }) {
  const zip = new AdmZip();
  zip.addFile(`${baseName}.pdf`, pdfBuffer);
  zip.addFile(`${baseName}.xml`, Buffer.from(signedXml, 'utf8'));
  return zip.toBuffer();
}

const DOC_LABELS = {
  factura: 'la factura electrónica',
  nota_credito: 'la nota crédito electrónica',
  nota_debito: 'la nota débito electrónica',
};

function buildEmailHtml(sale, tenant) {
  const empresa = tenant.dian_config?.company_name || tenant.company_name || 'Facturación electrónica';
  const docLabel = DOC_LABELS[sale.document_type] || 'el documento electrónico';
  const hashLabel = sale.document_type === 'factura' ? 'CUFE' : 'CUDE';
  return `
    <p>Estimado(a) ${sale.customer_name || 'cliente'},</p>
    <p>Adjunto encontrará ${docLabel} <strong>${sale.dian_invoice_number}</strong>,
       aceptada por la DIAN, junto con su archivo XML.</p>
    <p><strong>${hashLabel}:</strong> ${sale.cufe}</p>
    <p>Puede validar este documento en el portal de la DIAN usando el ${hashLabel} anterior.</p>
    <hr>
    <p><small>${empresa}</small></p>
  `;
}

/**
 * Envía al comprador el PDF+XML de una factura ya aceptada por la DIAN.
 * No lanza — quien invoque debe tratar el error como "no bloqueante"
 * (ver dianService.sendInvoiceToDian, se llama vía setImmediate).
 */
async function sendElectronicInvoiceEmail(sale, tenant, signedXml) {
  if (!sale.customer_email || !sale.customer_email.trim()) {
    logger.warn(`[DIAN] Factura ${sale.dian_invoice_number}: sin email de cliente, no se envía PDF+XML.`);
    return { sent: false, reason: 'no_customer_email' };
  }

  const pdfBuffer = await generateSalePDFBuffer(sale, tenant);
  const baseName = sale.dian_invoice_number || sale.sale_number;
  const zipBuffer = buildZip({ pdfBuffer, signedXml, baseName });

  const subjectPrefix = { factura: 'Factura electrónica', nota_credito: 'Nota crédito electrónica', nota_debito: 'Nota débito electrónica' }[sale.document_type] || 'Documento electrónico';

  await emailService.sendEmail({
    to: sale.customer_email.trim(),
    subject: `${subjectPrefix} ${sale.dian_invoice_number}`,
    html: buildEmailHtml(sale, tenant),
    attachments: [{ filename: `${baseName}.zip`, content: zipBuffer }],
  });

  logger.info(`[DIAN] PDF+XML de ${sale.dian_invoice_number} enviado a ${sale.customer_email}`);
  return { sent: true };
}

module.exports = { sendElectronicInvoiceEmail };
