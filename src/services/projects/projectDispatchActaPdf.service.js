// backend/src/services/projects/projectDispatchActaPdf.service.js
// Acta de despacho de materiales a obra: datos de la salida (proyecto, etapa,
// bodegas, traslado), tabla de materiales enviados y firmas dibujadas en
// pantalla de almacén, transportador y encargado de obra. Sin costos.
const PDFDocument = require('pdfkit');
const { downloadImage } = require('../pdfService');
const { drawSignatureBlocks, fmtDateTime } = require('./actaPdfCommon');

const HEX = /^#?([0-9a-f]{6})$/i;
const accentOf = (tenant) => {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
};
const qty = (n) => Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 });

const SIGN_ROLES = [['almacen', 'Almacén (entrega)'], ['transportador', 'Transportador'], ['encargado_obra', 'Encargado de obra (recibe)']];

async function generateDispatchActaPdf({ data, project, tenant }) {
  const { dispatch, stage, stageProgress, transfer, lines, signatures, fromWarehouse, toWarehouse, createdBy } = data;
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
  doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(tenant.company_name || '', tx, 32, { width: 250 });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text(tenant.tax_id ? `NIT ${tenant.tax_id}` : '', tx, 46, { width: 250 });
  doc.font('Helvetica-Bold').fontSize(14).fillColor(accent).text('ACTA DE DESPACHO', L + W - 250, 30, { width: 250, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(dispatch.dispatch_no, L + W - 250, 48, { width: 250, align: 'right' });

  let y = 78;
  const info = [
    ['Proyecto', `${project.code} · ${project.name}`],
    ['Etapa', stage ? `${stage.stage_no} · ${stage.name}${stageProgress ? ` (${stageProgress.pct}% despachado)` : ''}` : 'Sin etapa'],
    ['Fecha de salida', fmtDateTime(dispatch.dispatched_at)],
    ['Bodega origen', fromWarehouse || '—'],
    ['Bodega de la obra', toWarehouse || '—'],
    ['Traslado', transfer ? transfer.transfer_number : '—'],
  ];
  const colW = W / 3;
  info.forEach(([label, value], i) => {
    const cx = L + (i % 3) * colW;
    const cy = y + Math.floor(i / 3) * 32;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(label.toUpperCase(), cx, cy, { width: colW - 8 });
    doc.font('Helvetica').fontSize(9).fillColor(black).text(value, cx, cy + 10, { width: colW - 8, height: 20, ellipsis: true });
  });
  y += 72;
  if (dispatch.notes) {
    doc.font('Helvetica').fontSize(8).fillColor(gray).text(`Notas: ${dispatch.notes}`, L, y, { width: W });
    y = doc.y + 8;
  }

  // Tabla de materiales
  const cols = [['Línea', 34, 'left'], ['Código', 80, 'left'], ['Material', 258, 'left'], ['Unidad', 50, 'left'], ['Enviado', 56, 'right'], ['Recibido', 56, 'right']];
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
    const cells = [r.line_no ?? '', r.sku, r.name, r.unit, qty(r.qty_sent), r.qty_received === null ? '—' : qty(r.qty_received)];
    let x = L;
    doc.font('Helvetica').fontSize(8).fillColor(black);
    cols.forEach(([, w, align], i) => { doc.text(String(cells[i]), x + 4, y + 5, { width: w - 8, align, height: 11, ellipsis: true }); x += w; });
    y += 18;
  });
  if (!lines.length) { doc.font('Helvetica').fontSize(8).fillColor(gray).text('Sin materiales', L + 4, y + 5); y += 18; }
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`${lines.length} línea(s)${createdBy ? ` · Registró: ${createdBy}` : ''}`, L, y + 6, { width: W });
  y += 24;

  // Firmas
  if (y + 120 > bottom()) { doc.addPage(); y = 40; }
  y = Math.max(y, bottom() - 120);
  drawSignatureBlocks(doc, { signatures, roles: SIGN_ROLES, y, left: L, width: W });

  doc.end();
  return done;
}

module.exports = { generateDispatchActaPdf };
