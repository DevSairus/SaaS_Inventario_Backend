// backend/src/services/payroll/payrollVacationPdfService.js
//
// 6.5 — Comprobante en PDF de la liquidación de vacaciones fuera de período, para
// entregar al trabajador (con espacio de firmas). Misma paleta y mecanismo
// bufferMode/streaming que payrollTerminationPdfService.js.
'use strict';

const PDFDocument = require('pdfkit');

const formatCurrency = (v) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(v) || 0);
const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const fullName = (e) => [e.first_name, e.other_names, e.first_surname, e.second_surname].filter(Boolean).join(' ');
const days = (v) => String(Math.round((Number(v) || 0) * 100) / 100).replace('.', ',');

/**
 * @param {object|null} res  response de Express (streaming) o null para Buffer
 * @param {{ settlement: object, employee: object, tenant: object }} p
 */
async function generateVacationSettlementPDF(res, { settlement, employee, tenant }) {
  const bufferMode = !res;
  let bufferPromise = null;
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  if (!bufferMode) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Vacaciones-VAC-${settlement.doc_number}.pdf"`);
    doc.pipe(res);
  } else {
    const chunks = [];
    bufferPromise = new Promise((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
  }

  const red = '#8b0000';
  const gray = '#6b7280';
  const dark = '#374151';
  const border = '#d1d5db';
  const M = 40;
  const W = doc.page.width - M * 2;
  const anulada = settlement.status === 'anulada';
  const borrador = settlement.status === 'borrador';

  doc.rect(0, 0, doc.page.width, 5).fill(red);
  let y = 24;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(dark).text(tenant.company_name || 'Empresa', M, y, { width: W * 0.55 });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray).text([tenant.tax_id ? `NIT: ${tenant.tax_id}` : null, tenant.address].filter(Boolean).join('  ·  '), M, y + 16, { width: W * 0.55 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(red).text('LIQUIDACIÓN DE VACACIONES', M + W * 0.55, y, { width: W * 0.45, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text(`VAC-${settlement.doc_number}`, M + W * 0.55, y + 16, { width: W * 0.45, align: 'right' });
  if (anulada) doc.font('Helvetica-Bold').fontSize(10).fillColor(red).text('ANULADA', M + W * 0.55, y + 28, { width: W * 0.45, align: 'right' });
  else if (borrador) doc.font('Helvetica-Bold').fontSize(10).fillColor('#b45309').text('BORRADOR — SIN PAGAR', M + W * 0.55, y + 28, { width: W * 0.45, align: 'right' });
  y += 58;

  const rows = [
    ['Trabajador', fullName(employee)],
    ['Documento', employee.document_number || '—'],
    ['Cargo', employee.position || '—'],
    ['Fecha de ingreso', formatDate(employee.hire_date)],
    ['Salario base mensual', formatCurrency(settlement.base_salary)],
    ['Valor del día', formatCurrency(settlement.daily_value)],
  ];
  doc.roundedRect(M, y, W, rows.length / 2 * 16 + 26, 5).strokeColor(border).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('DATOS DEL TRABAJADOR', M + 12, y + 8);
  rows.forEach(([label, value], i) => {
    const cx = M + 12 + (i % 2) * (W / 2);
    const cy = y + 22 + Math.floor(i / 2) * 16;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(`${label}:`, cx, cy, { width: 92 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text(value, cx + 94, cy, { width: W / 2 - 110, lineBreak: false, ellipsis: true });
  });
  y += rows.length / 2 * 16 + 38;

  const section = (title) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(red).text(title, M, y);
    y += 14;
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    y += 6;
  };
  const line = (label, amount, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(dark).text(label, M, y, { width: W - 120 });
    doc.text(formatCurrency(amount), M + W - 110, y, { width: 110, align: 'right' });
    y += 15;
  };

  section('Detalle');
  if (Number(settlement.days_enjoyed) > 0) {
    line(`Vacaciones disfrutadas: ${days(settlement.days_enjoyed)} día(s), del ${formatDate(settlement.start_date)} al ${formatDate(settlement.end_date)}`, settlement.value_enjoyed);
  }
  if (Number(settlement.days_compensated) > 0) {
    line(`Vacaciones compensadas en dinero: ${days(settlement.days_compensated)} día(s)`, settlement.value_compensated);
  }
  line('Total a pagar', settlement.total_value, true);
  y += 4;
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`Fecha de pago: ${formatDate(settlement.payment_date)}${settlement.reference ? `  ·  Referencia: ${settlement.reference}` : ''}`, M, y, { width: W });
  y = doc.y + 6;
  doc.text('Los aportes a seguridad social de estas vacaciones se liquidan en la nómina del período en que se registran.', M, y, { width: W });
  y = doc.y + 6;
  if (anulada && settlement.void_reason) {
    doc.fillColor(red).text(`Motivo de la anulación: ${settlement.void_reason}`, M, y, { width: W });
    y = doc.y + 6;
  }
  if (settlement.notes) {
    doc.fillColor(gray).text(`Observaciones: ${settlement.notes}`, M, y, { width: W });
    y = doc.y + 6;
  }

  y = Math.max(y + 60, 600);
  doc.moveTo(M, y).lineTo(M + 200, y).strokeColor(dark).lineWidth(0.5).stroke();
  doc.moveTo(M + W - 200, y).lineTo(M + W, y).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(dark)
    .text('Firma del trabajador', M, y + 4, { width: 200 })
    .text('Firma del empleador', M + W - 200, y + 4, { width: 200 });

  doc.end();
  return bufferMode ? bufferPromise : undefined;
}

module.exports = { generateVacationSettlementPDF };
