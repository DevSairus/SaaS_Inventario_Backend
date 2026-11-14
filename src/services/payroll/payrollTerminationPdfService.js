// backend/src/services/payroll/payrollTerminationPdfService.js
/**
 * Comprobante en PDF de la liquidación definitiva de contrato (6.3), para
 * entregar al trabajador y archivar. Mismo mecanismo bufferMode/streaming y
 * misma paleta que payrollCertificatePdfService.js.
 *
 * Dos estados:
 *  - 'borrador': cálculo previo SIN emitir (marca "BORRADOR" visible); incluye
 *    el detalle de cómo se calculó cada prestación.
 *  - 'emitida': liquidación ya aceptada por la DIAN; se arma con lo que quedó
 *    firmado (snapshot del documento) y muestra número de documento y CUNE.
 */
'use strict';

const PDFDocument = require('pdfkit');
const { terminationReasonLabel } = require('./terminationReasons');

const CONTRACT_TYPE_LABELS = {
  '1': 'Término indefinido', '2': 'Término fijo', '3': 'Obra o labor', '4': 'Aprendizaje', '5': 'Otro',
};
const DOCUMENT_TYPE_LABELS = {
  '11': 'Registro Civil', '12': 'Tarjeta de Identidad', '13': 'Cédula de Ciudadanía',
  '21': 'Tarjeta de Extranjería', '22': 'Cédula de Extranjería', '31': 'NIT',
  '41': 'Pasaporte', '42': 'Documento de identificación extranjero', '47': 'PEP', '48': 'PPT',
};

const formatCurrency = (value) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value) || 0);

const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const employeeFullName = (employee) => [employee.first_name, employee.other_names, employee.first_surname, employee.second_surname]
  .filter(Boolean).join(' ');

/**
 * @param {object|null} res - response de Express para streaming, o null para Buffer
 * @param {object} p
 * @param {object} p.employee
 * @param {object} p.tenant
 * @param {'borrador'|'emitida'} p.status
 * @param {{start_date:string,end_date:string}} p.periodo - tramo de salario liquidado
 * @param {{devengadosLines:Array,deduccionesLines:Array}} p.resumen
 * @param {number} p.netoTotal
 * @param {object|null} p.breakdown - detalle del cálculo (solo borrador)
 * @param {string|null} p.terminationReason
 * @param {string|null} p.documentNumber
 * @param {string|null} p.cune
 * @param {boolean} p.excludesSalary - los días de salario hasta el retiro ya se pagaron en la nómina normal
 */
async function generateTerminationSettlementPDF(res, {
  employee, tenant, status, periodo, resumen, netoTotal, breakdown = null,
  terminationReason = null, documentNumber = null, cune = null, excludesSalary = false,
}) {
  const bufferMode = !res;
  let bufferPromise = null;
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

  if (!bufferMode) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Liquidacion-${employee.document_number || employee.id}.pdf"`);
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
  const darkGray = '#374151';
  const softGray = '#f9fafb';
  const borderMd = '#d1d5db';
  const border = '#e5e7eb';
  const amber = '#b45309';

  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const MARGIN = 40;
  const INNER_W = PAGE_W - MARGIN * 2;
  const BOTTOM = PAGE_H - 60;

  let y = 16;
  const ensureSpace = (needed) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      doc.rect(0, 0, PAGE_W, 5).fill(red);
      y = 24;
    }
  };

  doc.rect(0, 0, PAGE_W, 5).fill(red);

  /* ── Encabezado ── */
  const HDR_H = 78;
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
  doc.save();
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).clip();
  doc.rect(MARGIN, y, INNER_W, HDR_H).fill(softGray);
  doc.restore();

  const EMP_X = MARGIN + 14;
  const DOC_W = 210;
  const EMP_W = INNER_W - (EMP_X - MARGIN) - DOC_W - 16;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(darkGray).text(tenant.company_name || 'Empresa', EMP_X, y + 12, { width: EMP_W });
  const empDetails = [tenant.tax_id ? `NIT: ${tenant.tax_id}` : null, tenant.address, [tenant.phone, tenant.email].filter(Boolean).join('  ·  ')].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5).fillColor(gray);
  let ey = y + 27;
  empDetails.forEach((line) => { doc.text(line, EMP_X, ey, { width: EMP_W }); ey += 11; });

  const DX = MARGIN + INNER_W - DOC_W;
  const DW = DOC_W - 10;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(red).text('LIQUIDACIÓN DEFINITIVA', DX, y + 10, { width: DW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(red).text('DE CONTRATO DE TRABAJO', DX, y + 24, { width: DW, align: 'center' });
  if (status === 'emitida') {
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(`Documento ${documentNumber || '—'}`, DX, y + 42, { width: DW, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#059669').text('Aceptado por la DIAN', DX, y + 54, { width: DW, align: 'center' });
  } else {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(amber).text('BORRADOR — SIN EMITIR', DX, y + 46, { width: DW, align: 'center' });
  }
  y += HDR_H + 12;

  /* ── Trabajador ── */
  const rows = [
    ['Trabajador', employeeFullName(employee)],
    ['Documento', `${DOCUMENT_TYPE_LABELS[employee.document_type] || employee.document_type || ''} ${employee.document_number || ''}`.trim()],
    ['Cargo', employee.position || '—'],
    ['Tipo de contrato', CONTRACT_TYPE_LABELS[employee.contract_type] || '—'],
    ['Salario base mensual', formatCurrency(employee.base_salary)],
    ['Fecha de ingreso', formatDate(employee.hire_date)],
    ['Fecha de retiro', formatDate(employee.termination_date)],
    ['Causa del retiro', terminationReasonLabel(terminationReason) || 'Sin registrar'],
  ];
  const colW = INNER_W / 2;
  const boxH = Math.ceil(rows.length / 2) * 16 + 24;
  doc.roundedRect(MARGIN, y, INNER_W, boxH, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('DATOS DEL TRABAJADOR', MARGIN + 12, y + 8);
  rows.forEach(([label, value], i) => {
    const cx = MARGIN + 12 + (i % 2) * colW;
    const cy = y + 22 + Math.floor(i / 2) * 16;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(`${label}:`, cx, cy, { width: 92 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray).text(value, cx + 94, cy, { width: colW - 110, lineBreak: false, ellipsis: true });
  });
  y += boxH + 6;
  if (employee.termination_notes) {
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(`Observaciones del retiro: ${employee.termination_notes}`, MARGIN, y, { width: INNER_W });
    y = doc.y + 6;
  }
  if (excludesSalary) {
    doc.font('Helvetica').fontSize(7.5).fillColor(gray)
      .text('Los días de salario hasta la fecha de retiro se pagaron en la nómina del período; este comprobante liquida prestaciones sociales y demás conceptos.', MARGIN, y, { width: INNER_W });
    y = doc.y + 10;
  } else if (periodo?.start_date && periodo?.end_date) {
    doc.font('Helvetica').fontSize(7.5).fillColor(gray)
      .text(`Salario liquidado en este comprobante: del ${formatDate(periodo.start_date)} al ${formatDate(periodo.end_date)}.`, MARGIN, y, { width: INNER_W });
    y = doc.y + 10;
  } else {
    y += 4;
  }

  /* ── Detalle del cálculo (solo borrador) ── */
  const sectionTitle = (text) => {
    ensureSpace(26);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(red).text(text, MARGIN, y);
    y += 14;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(border).lineWidth(0.5).stroke();
    y += 6;
  };
  const line = (label, amount, { bold = false, indent = 0 } = {}) => {
    ensureSpace(15);
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(darkGray)
      .text(label, MARGIN + indent, y, { width: INNER_W - 120 - indent });
    const labelBottom = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(darkGray)
      .text(formatCurrency(amount), MARGIN + INNER_W - 110, y, { width: 110, align: 'right' });
    y = Math.max(labelBottom, y + 12) + 3;
  };

  if (breakdown) {
    sectionTitle('Cómo se calcularon las prestaciones');
    const { cesantias, prima, vacaciones } = breakdown;
    line(`Cesantías: ${cesantias.dias} días desde ${formatDate(cesantias.fechaInicioAcumulacion)}`, cesantias.cesantias);
    line(`Intereses sobre cesantías (12% anual sobre ${cesantias.dias} días)`, cesantias.intereses);
    line(`Prima de servicios: ${prima.dias} días del semestre ${prima.semestre}`, prima.primaCausada ?? prima.prima);
    if (prima.yaPagada > 0) line('Menos prima ya pagada en nómina', -prima.yaPagada, { indent: 12 });
    line(`Vacaciones pendientes: ${vacaciones.diasPendientes} días (${vacaciones.diasCausados} causados, ${vacaciones.diasYaTomados} tomados)`, vacaciones.valor);
    if (breakdown.indemnizacion > 0) line('Indemnización', breakdown.indemnizacion);
    if (breakdown.bonifRetiro > 0) line('Bonificación por retiro', breakdown.bonifRetiro);
    y += 4;
  }

  /* ── Devengados y deducciones ── */
  sectionTitle('Devengados');
  (resumen.devengadosLines || []).forEach((l) => line(l.label, l.amount));
  const totalDevengados = (resumen.devengadosLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  line('Total devengado', totalDevengados, { bold: true });
  y += 4;

  sectionTitle('Deducciones');
  if ((resumen.deduccionesLines || []).length === 0) {
    line('Sin deducciones', 0);
  } else {
    resumen.deduccionesLines.forEach((l) => line(l.label, l.amount));
  }
  const totalDeducciones = (resumen.deduccionesLines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  line('Total deducciones', totalDeducciones, { bold: true });
  y += 6;

  /* ── Neto ── */
  ensureSpace(40);
  doc.roundedRect(MARGIN, y, INNER_W, 30, 5).fill(softGray);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(darkGray).text('NETO A PAGAR', MARGIN + 14, y + 10);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(red).text(formatCurrency(netoTotal), MARGIN + INNER_W - 200, y + 8, { width: 186, align: 'right' });
  y += 44;

  if (status === 'emitida' && cune) {
    ensureSpace(30);
    doc.font('Helvetica').fontSize(6.5).fillColor(gray).text(`CUNE: ${cune}`, MARGIN, y, { width: INNER_W });
    y = doc.y + 8;
  }

  /* ── Declaración y firmas ── */
  ensureSpace(130);
  doc.font('Helvetica').fontSize(8).fillColor(darkGray).text(
    'El trabajador declara haber recibido a satisfacción el valor neto indicado por concepto de salarios, prestaciones sociales y demás acreencias laborales causadas hasta la fecha de terminación del contrato, salvo las reclamaciones que consten por escrito.',
    MARGIN, y, { width: INNER_W, align: 'justify' },
  );
  y = doc.y + 46;
  const sigW = (INNER_W - 40) / 2;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + sigW, y).strokeColor(darkGray).lineWidth(0.5).stroke();
  doc.moveTo(MARGIN + sigW + 40, y).lineTo(MARGIN + INNER_W, y).strokeColor(darkGray).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray)
    .text('EMPLEADOR', MARGIN, y + 4, { width: sigW, align: 'center' })
    .text('TRABAJADOR', MARGIN + sigW + 40, y + 4, { width: sigW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(tenant.company_name || '', MARGIN, y + 15, { width: sigW, align: 'center' })
    .text(`${employeeFullName(employee)} — ${employee.document_number || ''}`, MARGIN + sigW + 40, y + 15, { width: sigW, align: 'center' });

  /* ── Pie con paginación y marca de borrador ── */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    // El pie queda dentro del margen inferior: sin esto pdfkit agrega una página en blanco.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(gray)
      .text(`Página ${i + 1} de ${range.count}${status === 'borrador' ? '  ·  Borrador: no tiene validez hasta emitir la liquidación' : ''}`,
        MARGIN, PAGE_H - 36, { width: INNER_W, align: 'center', lineBreak: false });
  }

  doc.end();
  return bufferMode ? bufferPromise : undefined;
}

module.exports = { generateTerminationSettlementPDF };
