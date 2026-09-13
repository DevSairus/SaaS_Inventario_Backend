// backend/src/services/dian/payrollPdfService.js
/**
 * Representación gráfica (PDF) del Documento Soporte de Pago de Nómina
 * Electrónica — NO reutiliza generateSalePDF() de pdfService.js: el layout
 * es distinto (detalle de devengados/deducciones por concepto en vez de
 * líneas de producto), como ya se dejó anotado en el plan
 * (Plan-Implementacion-Nomina-Electronica-Nexora.md §3). Sí se reutiliza la
 * paleta/estilo general (misma cabecera roja, misma tipografía Helvetica)
 * para que se vea consistente con el resto de los documentos del sistema.
 *
 * Usa el mismo mecanismo bufferMode/streaming que generateSalePDF() —
 * res=null devuelve un Buffer (para adjuntar por correo), res!=null hace
 * streaming directo a la respuesta HTTP.
 */
'use strict';

const PDFDocument = require('pdfkit');
const https = require('https');
const http = require('http');
const QRCode = require('qrcode');
const { resumenLiquidacionParaImpresion } = require('../payroll/payrollService');

const downloadImage = (url) => new Promise((resolve, reject) => {
  const protocol = url.startsWith('https') ? https : http;
  const chunks = [];
  protocol.get(url, (res) => {
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  }).on('error', reject);
});

function formatCurrency(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value || 0);
}

function formatDate(isoDateStr) {
  if (!isoDateStr) return '—';
  const d = new Date(isoDateStr);
  if (Number.isNaN(d.getTime())) return String(isoDateStr);
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function employeeFullName(employee) {
  return [employee.first_name, employee.other_names, employee.first_surname, employee.second_surname]
    .filter(Boolean).join(' ');
}

/**
 * @param {object|null} res - response de Express para streaming, o null para buffer
 * @param {object} payrollDocument - instancia PayrollDocument con employee/period incluidos (o pasados aparte)
 * @param {object} employee
 * @param {object} period
 * @param {object} tenant
 */
async function generatePayrollDocumentPDF(res, payrollDocument, employee, period, tenant) {
  const bufferMode = !res;
  let bufferPromise = null;

  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

  if (!bufferMode) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Nomina-${payrollDocument.payroll_document_number || payrollDocument.id}.pdf"`);
    doc.pipe(res);
  } else {
    const chunks = [];
    bufferPromise = new Promise((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
  }

  /* ── PALETA (misma que el resto de los PDF del sistema) ── */
  const red = '#8b0000';
  const gray = '#6b7280';
  const darkGray = '#374151';
  const softGray = '#f9fafb';
  const border = '#e5e7eb';
  const borderMd = '#d1d5db';
  const black = '#111827';
  const green = '#059669';
  const redAmt = '#dc2626';
  const white = '#ffffff';

  const PAGE_W = doc.page.width;
  const MARGIN = 40;
  const INNER_W = PAGE_W - MARGIN * 2;

  doc.rect(0, 0, PAGE_W, 5).fill(red);

  let y = 16;

  /* ── ENCABEZADO: logo/empresa a la izq, título doc a la der ── */
  const HDR_H = 78;
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
  doc.save();
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).clip();
  doc.rect(MARGIN, y, INNER_W, HDR_H).fill(softGray);
  doc.restore();

  const LOGO_W = 90, LOGO_H = 44;
  const LOGO_X = MARGIN + 12;
  const LOGO_Y = y + (HDR_H - LOGO_H) / 2;
  let logoDrawn = false;
  if (tenant.logo_url) {
    try {
      let src;
      if (tenant.logo_url.startsWith('http')) src = await downloadImage(tenant.logo_url);
      if (src) {
        doc.image(src, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H], align: 'left', valign: 'center' });
        logoDrawn = true;
      }
    } catch (e) { /* sin logo */ }
  }

  const EMP_X = logoDrawn ? LOGO_X + LOGO_W + 14 : MARGIN + 14;
  const DOC_W = 170;
  const EMP_W = INNER_W - (EMP_X - MARGIN) - DOC_W - 16;

  doc.font('Helvetica-Bold').fontSize(12).fillColor(darkGray)
    .text(tenant.company_name || 'Empresa', EMP_X, y + 12, { width: EMP_W });

  const empDetails = [
    tenant.tax_id ? `NIT: ${tenant.tax_id}` : null,
    tenant.address,
    [tenant.phone, tenant.email].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5).fillColor(gray);
  let ey = y + 27;
  empDetails.forEach((line) => { doc.text(line, EMP_X, ey, { width: EMP_W }); ey += 11; });

  const DX = MARGIN + INNER_W - DOC_W;
  const DW = DOC_W - 10;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(red)
    .text('DOCUMENTO SOPORTE', DX, y + 10, { width: DW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(red)
    .text('DE PAGO DE NÓMINA ELECTRÓNICA', DX, y + 24, { width: DW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray)
    .text(payrollDocument.payroll_document_number || '—', DX, y + 46, { width: DW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(formatDate(payrollDocument.dian_sent_at || payrollDocument.created_at), DX, y + 59, { width: DW, align: 'center' });

  y += HDR_H + 12;

  /* ── EMPLEADO / PERIODO ── */
  const INFO_H = 60;
  doc.roundedRect(MARGIN, y, INNER_W, INFO_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
  const HALF = INNER_W / 2;
  doc.moveTo(MARGIN + HALF, y).lineTo(MARGIN + HALF, y + INFO_H).strokeColor(border).lineWidth(0.5).stroke();

  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('TRABAJADOR', MARGIN + 12, y + 10);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(employeeFullName(employee), MARGIN + 12, y + 21, { width: HALF - 24 });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`${employee.document_type ? 'CC/Doc: ' : ''}${employee.document_number || ''}`, MARGIN + 12, y + 34, { width: HALF - 24 });
  if (employee.position) doc.text(employee.position, MARGIN + 12, y + 45, { width: HALF - 24 });

  const PX = MARGIN + HALF + 12;
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('PERIODO DE PAGO', PX, y + 10);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray)
    .text(`${formatDate(period.start_date)} — ${formatDate(period.end_date)}`, PX, y + 21, { width: HALF - 24 });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`Tipo: ${period.period_type || '—'} · Fecha de pago: ${formatDate(period.payment_date)}`, PX, y + 34, { width: HALF - 24 });

  y += INFO_H + 14;

  /* ── TABLA DEVENGADOS / DEDUCCIONES ── */
  const { devengadosLines, deduccionesLines } = resumenLiquidacionParaImpresion(payrollDocument.snapshot_liquidation || {});

  const drawLinesTable = (title, lines, total, accentColor, startY) => {
    let ty = startY;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(title, MARGIN, ty);
    ty += 14;

    doc.rect(MARGIN, ty, INNER_W, 16).fill(softGray);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(gray)
      .text('CONCEPTO', MARGIN + 8, ty + 4)
      .text('VALOR', MARGIN + INNER_W - 110, ty + 4, { width: 100, align: 'right' });
    ty += 16;

    if (!lines.length) {
      doc.font('Helvetica').fontSize(8).fillColor(gray).text('Sin conceptos registrados.', MARGIN + 8, ty + 5);
      ty += 18;
    } else {
      lines.forEach((line, idx) => {
        if (idx % 2 === 1) doc.rect(MARGIN, ty, INNER_W, 15).fill('#fbfbfb');
        doc.font('Helvetica').fontSize(8).fillColor(black).text(line.label, MARGIN + 8, ty + 3, { width: INNER_W - 130 });
        doc.text(formatCurrency(line.amount), MARGIN + INNER_W - 110, ty + 3, { width: 100, align: 'right' });
        ty += 15;
      });
    }

    doc.moveTo(MARGIN, ty).lineTo(MARGIN + INNER_W, ty).strokeColor(border).lineWidth(0.5).stroke();
    ty += 4;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(accentColor)
      .text(`TOTAL ${title.toUpperCase()}`, MARGIN + 8, ty)
      .text(formatCurrency(total), MARGIN + INNER_W - 110, ty, { width: 100, align: 'right' });

    return ty + 20;
  };

  y = drawLinesTable('Devengados', devengadosLines, payrollDocument.devengados_total, green, y);
  y = drawLinesTable('Deducciones', deduccionesLines, payrollDocument.deducciones_total, redAmt, y);

  /* ── TOTAL A PAGAR ── */
  doc.roundedRect(MARGIN, y, INNER_W, 30, 4).fill(darkGray);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(white)
    .text('NETO A PAGAR', MARGIN + 12, y + 9)
    .text(formatCurrency(payrollDocument.comprobante_total), MARGIN + INNER_W - 160, y + 9, { width: 148, align: 'right' });
  y += 44;

  /* ── CUNE / QR ── */
  if (payrollDocument.cune) {
    const qrSize = 70;
    try {
      const qrDataUrl = await QRCode.toDataURL(payrollDocument.cune, { margin: 0 });
      const qrImg = Buffer.from(qrDataUrl.split(',')[1], 'base64');
      doc.image(qrImg, MARGIN, y, { fit: [qrSize, qrSize] });
    } catch (e) { /* sin QR */ }

    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('CUNE', MARGIN + qrSize + 12, y + 4);
    doc.font('Helvetica').fontSize(6.5).fillColor(gray)
      .text(payrollDocument.cune, MARGIN + qrSize + 12, y + 14, { width: INNER_W - qrSize - 12 });
    doc.font('Helvetica').fontSize(6.5).fillColor(gray)
      .text(`Estado DIAN: ${payrollDocument.dian_status || 'pending'}`, MARGIN + qrSize + 12, y + 44);
    y += qrSize + 10;
  }

  doc.font('Helvetica').fontSize(6.5).fillColor(gray)
    .text('Representación gráfica del Documento Soporte de Pago de Nómina Electrónica — Resolución DIAN 000013 de 2021.', MARGIN, y, { width: INNER_W, align: 'center' });

  doc.end();

  if (bufferMode) return bufferPromise;
  return null;
}

const generatePayrollDocumentPDFBuffer = (payrollDocument, employee, period, tenant) => generatePayrollDocumentPDF(null, payrollDocument, employee, period, tenant);

module.exports = { generatePayrollDocumentPDF, generatePayrollDocumentPDFBuffer };
