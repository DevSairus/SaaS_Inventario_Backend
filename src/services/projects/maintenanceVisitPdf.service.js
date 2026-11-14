// backend/src/services/projects/maintenanceVisitPdf.service.js
// Acta de visita de mantenimiento (Fase 4, req. 1.3): instalación, equipo,
// checklist con el resultado de cada tarea, observaciones y firmas del
// técnico y del cliente.
const PDFDocument = require('pdfkit');
const { downloadImage } = require('../pdfService');
const { drawSignatureBlocks, fmtDateTime } = require('./actaPdfCommon');

const HEX = /^#?([0-9a-f]{6})$/i;
const accentOf = (tenant) => {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
};
const STATUS = { scheduled: 'Programada', done: 'Realizada', cancelled: 'Cancelada' };
const fmtDate = (v) => (v ? new Date(`${String(v).slice(0, 10)}T12:00:00-05:00`).toLocaleDateString('es-CO', { dateStyle: 'long', timeZone: 'America/Bogota' }) : '—');

async function generateMaintenanceVisitPdf({ visit, tenant }) {
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
  doc.font('Helvetica-Bold').fontSize(14).fillColor(accent).text('VISITA DE MANTENIMIENTO', L + W - 280, 30, { width: 280, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(visit.visit_no, L + W - 280, 48, { width: 280, align: 'right' });

  let y = 80;
  const inst = visit.installation || {};
  const info = [
    ['Cliente', inst.customer || '—'],
    ['Instalación', `${inst.name || ''}${inst.project ? ` (${inst.project.code})` : ''}`],
    ['Dirección', [inst.site_address, inst.city].filter(Boolean).join(', ') || '—'],
    ['Plan', visit.plan ? `${visit.plan.name} (cada ${visit.plan.frequency_months} mes(es))` : '—'],
    ['Equipo', visit.equipment ? `${visit.equipment.name}${visit.equipment.serial ? ` · S/N ${visit.equipment.serial}` : ''}` : 'Instalación completa'],
    ['Técnico', visit.technician?.name || '—'],
    ['Fecha programada', fmtDate(visit.scheduled_date)],
    ['Fecha de la visita', visit.done_at ? fmtDateTime(visit.done_at) : '—'],
    ['Estado', STATUS[visit.status] || visit.status],
  ];
  const colW = W / 3;
  info.forEach(([label, value], i) => {
    const cx = L + (i % 3) * colW;
    const cy = y + Math.floor(i / 3) * 32;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(label.toUpperCase(), cx, cy, { width: colW - 8 });
    doc.font('Helvetica').fontSize(9).fillColor(black).text(value, cx, cy + 10, { width: colW - 8, height: 20, ellipsis: true });
  });
  y += Math.ceil(info.length / 3) * 32 + 8;

  // Checklist
  doc.font('Helvetica-Bold').fontSize(10).fillColor(accent).text('Checklist', L, y);
  y += 16;
  const tasks = visit.status === 'done' ? visit.checklist || [] : (visit.plan?.tasks || []).map((text) => ({ text, done: null }));
  for (const t of tasks) {
    if (y > bottom() - 40) { doc.addPage(); y = 40; }
    const mark = t.done === null ? '[  ]' : t.done ? '[X]' : '[ - ]';
    doc.font('Helvetica-Bold').fontSize(9).fillColor(t.done === false ? '#b91c1c' : black).text(mark, L, y, { width: 28 });
    doc.font('Helvetica').fontSize(9).fillColor(black).text(t.text, L + 30, y, { width: W - 30 });
    y = doc.y + 2;
    if (t.note) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(gray).text(t.note, L + 30, y, { width: W - 30 });
      y = doc.y + 2;
    }
    y += 3;
  }
  if (visit.status === 'done') {
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text('[X] realizada   [ - ] no realizada', L, y);
    y += 14;
  }

  if (visit.observations || visit.cancel_reason) {
    if (y > bottom() - 80) { doc.addPage(); y = 40; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accent).text(visit.cancel_reason ? 'Motivo de la cancelación' : 'Observaciones', L, y);
    y += 14;
    doc.font('Helvetica').fontSize(9).fillColor(black).text(visit.cancel_reason || visit.observations, L, y, { width: W });
    y = doc.y + 10;
  }

  if (y > bottom() - 110) { doc.addPage(); y = 40; }
  y += 20;
  const signatures = [];
  if (visit.technician) signatures.push({ role: 'tecnico', signed_name: visit.technician.name, signed_at: visit.done_at });
  if (visit.client_name) {
    signatures.push({ role: 'cliente', signed_name: visit.client_name, signed_document: visit.client_document, signature: visit.client_signature, signed_at: visit.done_at });
  }
  drawSignatureBlocks(doc, { signatures, roles: [['tecnico', 'Técnico'], ['cliente', 'Recibe (cliente)']], y, left: L, width: W });

  doc.end();
  return done;
}

module.exports = { generateMaintenanceVisitPdf };
