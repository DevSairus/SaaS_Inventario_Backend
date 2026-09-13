// backend/src/services/payroll/payrollCertificatePdfService.js
/**
 * Representación en PDF del Certificado de Ingresos y Retenciones anual
 * (mejora #6, base para el Formulario 220). Misma paleta/tipografía que
 * payrollPdfService.js para que se vea consistente con el resto de
 * documentos del sistema — pero es un documento propio del empleador
 * (no se firma ni se envía a la DIAN), por eso vive en services/payroll/ y
 * no en services/dian/.
 *
 * Usa el mismo mecanismo bufferMode/streaming que generateSalePDF() /
 * generatePayrollDocumentPDF() — res=null devuelve un Buffer, res!=null
 * hace streaming directo a la respuesta HTTP.
 */
'use strict';

const PDFDocument = require('pdfkit');

function formatCurrency(value) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value || 0);
}

function employeeFullName(employee) {
  return [employee.first_name, employee.other_names, employee.first_surname, employee.second_surname]
    .filter(Boolean).join(' ');
}

const DOCUMENT_TYPE_LABELS = {
  '11': 'Registro Civil', '12': 'Tarjeta de Identidad', '13': 'Cédula de Ciudadanía',
  '21': 'Tarjeta de Extranjería', '22': 'Cédula de Extranjería', '31': 'NIT',
  '41': 'Pasaporte', '42': 'Documento de identificación extranjero', '47': 'PEP', '48': 'PPT',
};

/**
 * @param {object|null} res - response de Express para streaming, o null para buffer
 * @param {object} params.employee - instancia Employee
 * @param {object} params.tenant - instancia Tenant (empleador)
 * @param {number} params.year - año fiscal certificado
 * @param {object} params.summary - salida de payrollCertificateService.js#summarizeDocuments (o getAnnualCertificateSummary)
 */
async function generateAnnualCertificatePDF(res, { employee, tenant, year, summary }) {
  const bufferMode = !res;
  let bufferPromise = null;

  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

  if (!bufferMode) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Certificado-Ingresos-Retenciones-${year}-${employee.document_number || employee.id}.pdf"`);
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

  /* ── ENCABEZADO: empresa a la izq, título doc a la der ── */
  const HDR_H = 78;
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
  doc.save();
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).clip();
  doc.rect(MARGIN, y, INNER_W, HDR_H).fill(softGray);
  doc.restore();

  const EMP_X = MARGIN + 14;
  const DOC_W = 190;
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
  doc.font('Helvetica-Bold').fontSize(12).fillColor(red)
    .text('CERTIFICADO DE INGRESOS', DX, y + 8, { width: DW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(red)
    .text('Y RETENCIONES', DX, y + 22, { width: DW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text('Base para el Formulario 220 (Art. 379 E.T.)', DX, y + 37, { width: DW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(darkGray)
    .text(`Año gravable ${year}`, DX, y + 52, { width: DW, align: 'center' });

  y += HDR_H + 12;

  /* ── TRABAJADOR ── */
  const INFO_H = 46;
  doc.roundedRect(MARGIN, y, INNER_W, INFO_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('TRABAJADOR CERTIFICADO', MARGIN + 12, y + 9);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(darkGray).text(employeeFullName(employee), MARGIN + 12, y + 20, { width: INNER_W - 24 });
  const docLabel = DOCUMENT_TYPE_LABELS[employee.document_type] || 'Doc.';
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`${docLabel}: ${employee.document_number || '—'}${employee.position ? '   ·   Cargo: ' + employee.position : ''}`, MARGIN + 12, y + 33, { width: INNER_W - 24 });

  y += INFO_H + 14;

  /* ── TABLA: CONCEPTOS DE INGRESOS ── */
  const drawSectionTable = (title, rows, total, totalLabel, accentColor, startY) => {
    let ty = startY;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(title, MARGIN, ty);
    ty += 14;

    doc.rect(MARGIN, ty, INNER_W, 16).fill(softGray);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(gray)
      .text('CONCEPTO', MARGIN + 8, ty + 4)
      .text('VALOR', MARGIN + INNER_W - 110, ty + 4, { width: 100, align: 'right' });
    ty += 16;

    rows.forEach((row, idx) => {
      if (idx % 2 === 1) doc.rect(MARGIN, ty, INNER_W, 15).fill('#fbfbfb');
      doc.font('Helvetica').fontSize(8).fillColor(black).text(row.label, MARGIN + 8, ty + 3, { width: INNER_W - 130 });
      doc.text(formatCurrency(row.amount), MARGIN + INNER_W - 110, ty + 3, { width: 100, align: 'right' });
      ty += 15;
    });

    doc.moveTo(MARGIN, ty).lineTo(MARGIN + INNER_W, ty).strokeColor(border).lineWidth(0.5).stroke();
    ty += 4;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(accentColor)
      .text(totalLabel, MARGIN + 8, ty)
      .text(formatCurrency(total), MARGIN + INNER_W - 110, ty, { width: 100, align: 'right' });

    return ty + 20;
  };

  const ingresosRows = [
    { label: 'Ingresos laborales gravados (salarios y demás pagos laborales)', amount: summary.ingresos.ingresosLaboralesGravados },
    { label: 'Auxilio de transporte (ingreso no constitutivo de renta)', amount: summary.ingresos.auxilioTransporte },
    { label: 'Cesantías e intereses a las cesantías (Art. 206 E.T.)', amount: summary.ingresos.cesantiasEIntereses },
    { label: 'Indemnizaciones', amount: summary.ingresos.indemnizacion },
  ].filter((r) => r.amount);

  y = drawSectionTable('Ingresos del periodo', ingresosRows.length ? ingresosRows : [{ label: 'Sin ingresos registrados', amount: 0 }], summary.totales.totalDevengados, 'TOTAL INGRESOS DEL AÑO', green, y);

  const deduccionesRows = [
    { label: 'Aportes obligatorios a salud', amount: summary.deducciones.aportesSalud },
    { label: 'Aportes obligatorios a fondos de pensión y solidaridad pensional', amount: summary.deducciones.aportesPensionObligatoria },
    { label: 'Aportes voluntarios a fondos de pensión', amount: summary.deducciones.aportesPensionVoluntaria },
    { label: 'Aportes a cuentas AFC', amount: summary.deducciones.aportesAFC },
    { label: 'Retención en la fuente practicada', amount: summary.deducciones.retencionFuente },
  ].filter((r) => r.amount);

  y = drawSectionTable('Deducciones y retenciones del periodo', deduccionesRows.length ? deduccionesRows : [{ label: 'Sin deducciones registradas', amount: 0 }], summary.totales.totalDeducciones, 'TOTAL DEDUCCIONES DEL AÑO', redAmt, y);

  /* ── RETENCIÓN DESTACADA + NETO ── */
  const boxW = (INNER_W - 12) / 2;
  doc.roundedRect(MARGIN, y, boxW, 34, 4).fill(darkGray);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text('RETENCIÓN EN LA FUENTE TOTAL', MARGIN + 12, y + 8, { width: boxW - 24 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(white).text(formatCurrency(summary.deducciones.retencionFuente), MARGIN + 12, y + 19, { width: boxW - 24 });

  doc.roundedRect(MARGIN + boxW + 12, y, boxW, 34, 4).fill(darkGray);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text('NETO PAGADO EN EL AÑO', MARGIN + boxW + 24, y + 8, { width: boxW - 24 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(white).text(formatCurrency(summary.totales.totalNeto), MARGIN + boxW + 24, y + 19, { width: boxW - 24 });

  y += 34 + 16;

  doc.font('Helvetica').fontSize(7).fillColor(gray)
    .text(`Certificado con base en ${summary.documentosCount} Documento(s) Soporte de Pago de Nómina Electrónica aceptado(s) por la DIAN durante el año ${year}.`, MARGIN, y, { width: INNER_W });
  y += 20;

  doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(gray)
    .text('Este certificado resume, en la estructura del Formulario 220 vigente (Art. 379 del Estatuto Tributario), los valores ya reportados en los Documentos Soporte de Pago de Nómina Electrónica emitidos durante el año. La separación entre ingresos gravados y no gravados/exentos es informativa y debe verificarse contra la normativa vigente antes de su uso tributario formal.', MARGIN, y, { width: INNER_W, align: 'justify' });

  doc.end();

  if (bufferMode) return bufferPromise;
  return null;
}

const generateAnnualCertificatePDFBuffer = (params) => generateAnnualCertificatePDF(null, params);

module.exports = { generateAnnualCertificatePDF, generateAnnualCertificatePDFBuffer };
