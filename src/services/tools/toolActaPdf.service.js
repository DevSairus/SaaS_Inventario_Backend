// backend/src/services/tools/toolActaPdf.service.js
// Acta de entrega / devolución de una herramienta (ver tools.service.js).
// Lleva los datos de la herramienta, el responsable, el proyecto, el estado
// y la firma capturada en pantalla (PNG). Sin firma digital queda el espacio
// para firmar en papel.
const PDFDocument = require('pdfkit');
const { downloadImage } = require('../pdfService');

const HEX = /^#?([0-9a-f]{6})$/i;
const accentOf = (tenant) => {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
};
function fmtDay(value) {
  if (!value) return '—';
  const v = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value;
  return new Date(v).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' });
}
const userName = (u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : '—');
const CONDITION = { good: 'Buen estado', damaged: 'Con daño', lost: 'Perdida' };

/**
 * @param {object} a - ToolAssignment con tool, project, deliverer, receiver
 * @param {object} tenant
 * @param {'delivery'|'return'} kind
 */
async function generateToolActaPdf(a, tenant, kind) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const accent = accentOf(tenant);
  const gray = '#6b7280';
  const black = '#111827';
  const W = doc.page.width - 100;
  const isReturn = kind === 'return';
  const tool = a.tool;

  // Encabezado
  let y = 50;
  let textX = 50;
  if (tenant.logo_url && tenant.logo_url.startsWith('http')) {
    try {
      const logo = await downloadImage(tenant.logo_url);
      doc.image(logo, 50, y, { fit: [90, 45] });
      textX = 150;
    } catch { /* sin logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(12).fillColor(black).text(tenant.company_name || 'Empresa', textX, y, { width: 260 });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text([tenant.tax_id ? `NIT ${tenant.tax_id}` : null, tenant.address].filter(Boolean).join(' · '), textX, y + 16, { width: 260 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor(accent)
    .text(isReturn ? 'ACTA DE DEVOLUCIÓN' : 'ACTA DE ENTREGA', 330, y, { width: W + 50 - 330, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(black).text(`${a.number}`, 330, y + 20, { width: W + 50 - 330, align: 'right' });
  doc.fillColor(gray).text(`Herramienta ${tool.code}`, 330, y + 32, { width: W + 50 - 330, align: 'right' });
  y += 70;
  doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(accent).lineWidth(1.5).stroke();
  y += 14;

  const row = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(gray).text(label, 50, y, { width: 150 });
    doc.font('Helvetica').fontSize(10).fillColor(black).text(value || '—', 200, y, { width: W - 150 });
    y = Math.max(doc.y, y + 14) + 4;
  };
  const section = (title) => {
    y += 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accent).text(title.toUpperCase(), 50, y);
    y = doc.y + 6;
  };

  section('Herramienta');
  row('Código', tool.code);
  row('Descripción', [tool.name, tool.brand, tool.model].filter(Boolean).join(' · '));
  if (tool.serial_number) row('Serial', tool.serial_number);
  row('Cantidad', String(a.quantity));

  section('Responsable');
  row('Nombre', a.responsible_name);
  if (a.responsible_document) row('Documento', a.responsible_document);
  row('Proyecto', a.project ? `${a.project.code} · ${a.project.name}` : 'Sin proyecto (uso general)');

  section(isReturn ? 'Devolución' : 'Entrega');
  if (isReturn) {
    row('Fecha de entrega', fmtDay(a.assigned_at));
    row('Fecha de devolución', fmtDay(a.returned_at));
    row('Estado', CONDITION[a.return_condition] || '—');
    if (a.lost_quantity) row('Unidades perdidas', String(a.lost_quantity));
    if (a.return_notes) row('Observaciones', a.return_notes);
    row('Recibió', userName(a.receiver));
  } else {
    row('Fecha de entrega', fmtDay(a.assigned_at));
    if (a.expected_return_date) row('Devolución prevista', fmtDay(a.expected_return_date));
    row('Estado al entregar', CONDITION[a.delivery_condition] || 'Buen estado');
    if (a.delivery_notes) row('Observaciones', a.delivery_notes);
    row('Entregó', userName(a.deliverer));
  }

  y += 10;
  doc.font('Helvetica').fontSize(8.5).fillColor(gray).text(isReturn
    ? 'Con esta acta se deja constancia de la devolución de la herramienta en el estado descrito.'
    : 'El responsable declara recibir la herramienta en el estado descrito y se compromete a usarla para las labores de la empresa, cuidarla y devolverla cuando se le solicite. Cualquier daño o pérdida debe reportarse de inmediato.',
  50, y, { width: W, align: 'justify' });
  y = doc.y + 30;

  // Firmas
  const sig = isReturn ? a.return_signature : a.delivery_signature;
  const signedName = isReturn ? a.return_signed_name : a.delivery_signed_name;
  const colW = (W - 40) / 2;
  if (sig) {
    try {
      const buf = Buffer.from(sig.split(',')[1], 'base64');
      doc.image(buf, 50, y, { fit: [colW, 70] });
    } catch { /* firma ilegible: queda la línea */ }
  }
  const lineY = y + 75;
  doc.moveTo(50, lineY).lineTo(50 + colW, lineY).strokeColor('#9ca3af').lineWidth(0.8).stroke();
  doc.moveTo(90 + colW, lineY).lineTo(50 + W, lineY).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(black)
    .text(signedName || a.responsible_name, 50, lineY + 5, { width: colW })
    .text(userName(isReturn ? a.receiver : a.deliverer), 90 + colW, lineY + 5, { width: colW });
  doc.font('Helvetica').fontSize(8).fillColor(gray)
    .text(isReturn ? 'Entrega (responsable)' : 'Recibe (responsable)', 50, lineY + 18, { width: colW })
    .text(isReturn ? 'Recibe (empresa)' : 'Entrega (empresa)', 90 + colW, lineY + 18, { width: colW });
  if (sig) {
    doc.fontSize(7).text('Firmado en pantalla en Pitbox', 50, lineY + 30, { width: colW });
  }

  doc.end();
  return done;
}

module.exports = { generateToolActaPdf };
