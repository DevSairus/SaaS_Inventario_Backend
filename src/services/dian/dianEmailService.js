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
const { resolveInvoiceRecipients } = require('../../utils/emailRecipients');

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
 * Correos a los que va la factura: el principal del comprador más los
 * adicionales (los propios de la factura si se definieron; si no, los
 * actuales del cliente).
 */
async function resolveRecipients(sale) {
  let customerAdditional = [];
  if (!Array.isArray(sale.additional_emails_override) && sale.customer_id) {
    const { Customer } = require('../../models');
    const customer = await Customer.findByPk(sale.customer_id, { attributes: ['id', 'additional_emails'] });
    customerAdditional = customer?.additional_emails || [];
  }
  return resolveInvoiceRecipients({
    primary: sale.customer_email,
    saleOverride: sale.additional_emails_override,
    customerAdditional,
  });
}

/**
 * Envía al comprador el PDF+XML de una factura ya aceptada por la DIAN.
 * Un correo POR destinatario (nadie ve las direcciones de los demás) y el
 * resultado de cada uno queda en sales.email_delivery.
 *
 * No lanza por fallos de envío — quien invoque debe tratar el error como
 * "no bloqueante" (ver dianService.sendInvoiceToDian, se llama vía
 * setImmediate). Devuelve { sent, recipients } donde `sent` es true si al
 * menos un destinatario recibió el correo.
 */
async function sendElectronicInvoiceEmail(sale, tenant, signedXml) {
  const recipients = await resolveRecipients(sale);
  if (recipients.length === 0) {
    logger.warn(`[DIAN] Factura ${sale.dian_invoice_number}: sin email de cliente, no se envía PDF+XML.`);
    return { sent: false, reason: 'no_customer_email', recipients: [] };
  }

  const pdfBuffer = await generateSalePDFBuffer(sale, tenant);
  const baseName = sale.dian_invoice_number || sale.sale_number;
  const zipBuffer = buildZip({ pdfBuffer, signedXml, baseName });

  const subjectPrefix = { factura: 'Factura electrónica', nota_credito: 'Nota crédito electrónica', nota_debito: 'Nota débito electrónica' }[sale.document_type] || 'Documento electrónico';
  const subject = `${subjectPrefix} ${sale.dian_invoice_number}`;
  const html = buildEmailHtml(sale, tenant);

  const results = [];
  for (const email of recipients) {
    try {
      const response = await emailService.sendEmail({
        to: email,
        subject,
        html,
        attachments: [{ filename: `${baseName}.zip`, content: zipBuffer }],
      });
      if (response?.mode === 'log') {
        results.push({ email, status: 'skipped', error: 'Servicio de correo no configurado' });
      } else {
        results.push({ email, status: 'sent' });
      }
    } catch (err) {
      logger.error(`[DIAN] Error enviando ${sale.dian_invoice_number} a ${email}: ${err.message}`);
      results.push({ email, status: 'failed', error: String(err.message || err).slice(0, 300) });
    }
  }

  const delivery = { sent_at: new Date().toISOString(), recipients: results };
  try {
    const { Sale } = require('../../models');
    await Sale.update({ email_delivery: delivery }, { where: { id: sale.id } });
  } catch (err) {
    logger.error(`[DIAN] No se pudo guardar el registro de entrega de ${sale.dian_invoice_number}: ${err.message}`);
  }

  const sentCount = results.filter((r) => r.status === 'sent').length;
  logger.info(`[DIAN] PDF+XML de ${sale.dian_invoice_number}: ${sentCount}/${results.length} destinatarios`);
  return { sent: sentCount > 0, recipients: results };
}

module.exports = { sendElectronicInvoiceEmail, resolveRecipients };
