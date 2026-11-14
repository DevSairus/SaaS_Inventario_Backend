// backend/src/services/projects/projectCutActaPdf.service.js
// Acta de corte de obra (avance parcial): avance por línea del contrato con
// anterior / este corte / acumulado, valor del corte, amortización del
// anticipo, retención de garantía, neto a pagar y firmas.
const PDFDocument = require('pdfkit');
const { downloadImage } = require('../pdfService');

const HEX = /^#?([0-9a-f]{6})$/i;
const accentOf = (tenant) => {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
};
const cop = (n) => `$ ${Math.round(Number(n) || 0).toLocaleString('es-CO')}`;
const qty = (n) => Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 });
const fmtDay = (v) => (v ? new Date(`${v}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
const customerName = (c) => (c ? c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ') : '—');

async function generateCutActaPdf({ cut, project, customer, contract, tenant }) {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36 });
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

  let tx = L;
  if (tenant.logo_url && tenant.logo_url.startsWith('http')) {
    try {
      doc.image(await downloadImage(tenant.logo_url), L, 30, { fit: [90, 40] });
      tx = L + 100;
    } catch { /* sin logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(12).fillColor(black).text(tenant.company_name || '', tx, 32, { width: 300 });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text(tenant.tax_id ? `NIT ${tenant.tax_id}` : '', tx, 48, { width: 300 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor(accent).text(`ACTA DE CORTE DE OBRA N.° ${cut.cut_no}`, L + W - 330, 30, { width: 330, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(black).text(`${project.code} · ${project.name}`, L + W - 330, 50, { width: 330, align: 'right' });

  let y = 80;
  const info = [
    ['Cliente', `${customerName(customer)}${customer?.tax_id ? ` · NIT/CC ${customer.tax_id}` : ''}`],
    ['Contrato', `${contract.quote.quote_number || contract.quote.sale_number} · ${cop(contract.total)}`],
    ['Fecha del corte', fmtDay(cut.cut_date)],
    ['Periodo', cut.period_from || cut.period_to ? `${fmtDay(cut.period_from)} a ${fmtDay(cut.period_to)}` : '—'],
  ];
  const colW = W / 4;
  info.forEach(([label, value], i) => {
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(label.toUpperCase(), L + i * colW, y, { width: colW - 8 });
    doc.font('Helvetica').fontSize(9).fillColor(black).text(value, L + i * colW, y + 10, { width: colW - 8 });
  });
  y += 36;

  // Tabla de avance
  const cols = [
    ['Ítem del contrato', 250, 'left'], ['Contratado', 62, 'right'], ['Anterior', 58, 'right'], ['Este corte', 62, 'right'],
    ['Acumulado', 62, 'right'], ['% acum.', 48, 'right'], ['Valor unitario', 85, 'right'], ['Valor del corte', W - 627, 'right'],
  ];
  const header = () => {
    doc.rect(L, y, W, 16).fill('#f3f4f6');
    let x = L;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(gray);
    for (const [label, w, align] of cols) { doc.text(label, x + 4, y + 4, { width: w - 8, align }); x += w; }
    y += 18;
  };
  header();
  const cutById = new Map((cut.items || []).map((i) => [i.sale_item_id, i]));
  // Todas las líneas del contrato, con o sin avance en este corte.
  for (const l of contract.lines) {
    const it = cutById.get(l.sale_item_id);
    const prev = it ? Number(it.qty_previous) : null;
    const thisQty = it ? Number(it.qty_this) : 0;
    const cum = it ? Number(it.qty_cumulative) : null;
    if (y > doc.page.height - 150) { doc.addPage(); y = 40; header(); }
    const values = [
      l.description, qty(l.qty_contract), prev === null ? '—' : qty(prev), thisQty ? qty(thisQty) : '—',
      cum === null ? '—' : qty(cum), cum === null ? '—' : `${Math.round((cum / l.qty_contract) * 100)} %`,
      cop(l.unit_price), it ? cop(it.amount) : '—',
    ];
    let x = L;
    let h = 0;
    doc.font('Helvetica').fontSize(8).fillColor(black);
    values.forEach((v, i) => {
      const [, w, align] = cols[i];
      doc.text(v, x + 4, y, { width: w - 8, align });
      h = Math.max(h, doc.heightOfString(v, { width: w - 8 }));
      x += w;
    });
    y += h + 5;
    doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
  }

  // Totales
  y += 6;
  if (y > doc.page.height - 190) { doc.addPage(); y = 40; }
  const totalRow = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor(black)
      .text(label, L + W - 380, y, { width: 260, align: 'right' }).text(value, L + W - 115, y, { width: 115, align: 'right' });
    y += bold ? 16 : 13;
  };
  doc.font('Helvetica').fontSize(8.5).fillColor(gray)
    .text(`Avance acumulado del contrato: ${Number(cut.progress_pct || 0).toLocaleString('es-CO')} %`, L, y, { width: 300 });
  totalRow('Valor del avance (costo directo)', cop(cut.direct_amount));
  if (Number(cut.aiu_amount) > 0) {
    const pct = (n) => `${Number(n || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`;
    totalRow(cut.aiu_enabled ? `AIU (A ${pct(cut.aiu_admin_pct)} · I ${pct(cut.aiu_unforeseen_pct)} · U ${pct(cut.aiu_profit_pct)})` : 'AIU', cop(cut.aiu_amount));
  }
  totalRow('Subtotal', cop(cut.subtotal));
  totalRow('IVA', cop(cut.tax_amount));
  totalRow('Total del corte', cop(cut.total_amount), true);
  if (Number(cut.advance_amount) > 0) totalRow('Menos: amortización del anticipo', `- ${cop(cut.advance_amount)}`);
  if (Number(cut.retention_amount) > 0) totalRow(`Menos: retención de garantía (${Number(project.retention_pct)} %)`, `- ${cop(cut.retention_amount)}`);
  totalRow('Neto a pagar', cop(cut.net_amount), true);
  if (cut.sale) {
    doc.font('Helvetica').fontSize(8).fillColor(gray).text(`Factura ${cut.sale.sale_number}`, L + W - 380, y, { width: 375, align: 'right' });
    y += 12;
  }
  if (cut.notes) {
    doc.font('Helvetica').fontSize(8.5).fillColor(black).text(`Observaciones: ${cut.notes}`, L, y + 4, { width: W });
    y = doc.y + 4;
  }

  // Firmas
  y += 24;
  if (y > doc.page.height - 90) { doc.addPage(); y = 60; }
  const sw = (W - 60) / 2;
  if (cut.approved_signature) {
    try { doc.image(Buffer.from(cut.approved_signature.split(',')[1], 'base64'), L, y - 4, { fit: [sw, 50] }); } catch { /* sin firma */ }
  }
  const lineY = y + 50;
  doc.moveTo(L, lineY).lineTo(L + sw, lineY).strokeColor('#9ca3af').lineWidth(0.8).stroke();
  doc.moveTo(L + sw + 60, lineY).lineTo(L + W, lineY).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(black)
    .text(cut.approved_by_name || 'Cliente', L, lineY + 4, { width: sw })
    .text(tenant.company_name || 'Contratista', L + sw + 60, lineY + 4, { width: sw });
  doc.font('Helvetica').fontSize(7.5).fillColor(gray)
    .text(`Aprueba (cliente)${cut.approved_by_document ? ` · ${cut.approved_by_document}` : ''}${cut.approved_at ? ` · ${new Date(cut.approved_at).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}` : ''}`, L, lineY + 16, { width: sw })
    .text('Contratista', L + sw + 60, lineY + 16, { width: sw });

  doc.end();
  return done;
}

module.exports = { generateCutActaPdf };
