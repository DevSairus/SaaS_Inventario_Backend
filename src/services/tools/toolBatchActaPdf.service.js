// backend/src/services/tools/toolBatchActaPdf.service.js
// Acta de entrega o devolución de un lote de herramientas a una obra (ver
// toolBatches.service.js): datos del lote, tabla de herramientas con su
// estado y las firmas dibujadas en pantalla de almacén, transportador y
// encargado de obra.
const PDFDocument = require('pdfkit');
const { downloadImage } = require('../pdfService');
const { drawSignatureBlocks, fmtDateTime } = require('../projects/actaPdfCommon');
const { SIGN_ROLES } = require('./toolBatches.service');

const HEX = /^#?([0-9a-f]{6})$/i;
const accentOf = (tenant) => {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
};
const fmtDay = (v) => (v ? new Date(`${v}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const CONDITION = { good: 'Buen estado', damaged: 'Con daño', lost: 'Perdida' };

async function generateToolBatchActaPdf({ data, tenant }) {
  const { batch, project, stage, lines, signatures, createdBy } = data;
  const isReturn = batch.kind === 'return';
  const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const accent = accentOf(tenant);
  const gray = '#6b7280';
  const black = '#111827';
  const L = 36;
  const W = doc.page.width - 72;
  const bottom = () => doc.page.height - 48;

  let tx = L;
  if (tenant.logo_url && tenant.logo_url.startsWith('http')) {
    try {
      doc.image(await downloadImage(tenant.logo_url), L, 30, { fit: [80, 36] });
      tx = L + 90;
    } catch { /* sin logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(tenant.company_name || '', tx, 32, { width: 220 });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text(tenant.tax_id ? `NIT ${tenant.tax_id}` : '', tx, 46, { width: 220 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(accent)
    .text(isReturn ? 'ACTA DE DEVOLUCIÓN DE HERRAMIENTAS' : 'ACTA DE ENTREGA DE HERRAMIENTAS', L + W - 300, 30, { width: 300, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(batch.batch_no, L + W - 300, 48, { width: 300, align: 'right' });

  let y = 78;
  const info = [
    ['Proyecto', project ? `${project.code} · ${project.name}` : '—'],
    ['Etapa', stage ? `${stage.stage_no} · ${stage.name}` : 'Sin etapa'],
    ['Fecha', fmtDay(batch.batch_date)],
    [isReturn ? 'Encargado de obra' : 'Recibe en obra', batch.responsible_name ? `${batch.responsible_name}${batch.responsible_document ? ` · ${batch.responsible_document}` : ''}` : '—'],
    ['Registró', createdBy || '—'],
    ['Herramientas', String(lines.length)],
  ];
  const colW = W / 3;
  info.forEach(([label, value], i) => {
    const cx = L + (i % 3) * colW;
    const cy = y + Math.floor(i / 3) * 32;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(label.toUpperCase(), cx, cy, { width: colW - 8 });
    doc.font('Helvetica').fontSize(9).fillColor(black).text(value, cx, cy + 10, { width: colW - 8, height: 20, ellipsis: true });
  });
  y += 72;
  if (batch.notes) {
    doc.font('Helvetica').fontSize(8).fillColor(gray).text(`Notas: ${batch.notes}`, L, y, { width: W });
    y = doc.y + 8;
  }

  // Tabla de herramientas
  const cols = isReturn
    ? [['Código', 60, 'left'], ['Herramienta', 170, 'left'], ['S/N', 70, 'left'], ['Cant.', 34, 'right'], ['Estado', 64, 'left'], ['Perd.', 34, 'right'], ['Observaciones', 130, 'left']]
    : [['Código', 60, 'left'], ['Herramienta', 190, 'left'], ['S/N', 80, 'left'], ['Cant.', 36, 'right'], ['Estado', 70, 'left'], ['Observaciones', 128, 'left']];
  const drawHead = () => {
    doc.rect(L, y, W, 18).fill(accent);
    let x = L;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    cols.forEach(([h, w, align]) => { doc.text(h, x + 4, y + 5, { width: w - 8, align }); x += w; });
    y += 18;
  };
  drawHead();
  lines.forEach((r, idx) => {
    if (y + 18 > bottom() - 150) { doc.addPage(); y = 40; drawHead(); }
    if (idx % 2) doc.rect(L, y, W, 18).fill('#f3f4f6');
    const cells = isReturn
      ? [r.code, r.name, r.serial, r.quantity, CONDITION[r.return_condition] || '—', r.lost_quantity || '', r.return_notes || '']
      : [r.code, r.name, r.serial, r.quantity, CONDITION[r.delivery_condition] || '—', r.delivery_notes || ''];
    let x = L;
    doc.font('Helvetica').fontSize(8).fillColor(black);
    cols.forEach(([, w, align], i) => { doc.text(String(cells[i]), x + 4, y + 5, { width: w - 8, align, height: 11, ellipsis: true }); x += w; });
    y += 18;
  });
  if (!lines.length) { doc.font('Helvetica').fontSize(8).fillColor(gray).text('Sin herramientas', L + 4, y + 5); y += 18; }
  y += 14;

  // Firmas
  if (y + 120 > bottom()) { doc.addPage(); y = 40; }
  y = Math.max(y, bottom() - 120);
  drawSignatureBlocks(doc, { signatures, roles: SIGN_ROLES[batch.kind], y, left: L, width: W });

  doc.end();
  return done;
}

module.exports = { generateToolBatchActaPdf };
