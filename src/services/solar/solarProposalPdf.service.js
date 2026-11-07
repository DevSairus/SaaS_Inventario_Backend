// backend/src/services/solar/solarProposalPdf.service.js
// Propuesta técnico-económica del estudio solar (equivalente al PDF del
// cotizador original): sistema dimensionado, producción mensual, oferta,
// ahorro, retorno y forma de pago. La cotización COT- conserva su propio
// formato (quotePdfService.js).
const PDFDocument = require('pdfkit');
const { downloadImage } = require('../pdfService');

const HEX = /^#?([0-9a-f]{6})$/i;
const accentOf = (tenant) => {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
};
const cop = (n) => `$ ${Math.round(Number(n) || 0).toLocaleString('es-CO')}`;
const int = (n) => Math.round(Number(n) || 0).toLocaleString('es-CO');
const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const SYSTEM = { ongrid: 'Conectado a la red (on-grid)', offgrid: 'Aislado (off-grid)', hybrid: 'Híbrido' };

async function generateSolarProposalPdf(study, tenant, settings) {
  const r = study.results || {};
  const doc = new PDFDocument({ size: 'LETTER', margin: 45 });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const accent = accentOf(tenant);
  const gray = '#6b7280';
  const black = '#111827';
  const L = 45;
  const W = doc.page.width - 90;

  // Encabezado
  doc.rect(0, 0, doc.page.width, 80).fill(accent);
  let tx = L;
  if (tenant.logo_url && tenant.logo_url.startsWith('http')) {
    try {
      const logo = await downloadImage(tenant.logo_url);
      doc.roundedRect(L, 14, 100, 52, 6).fill('#ffffff');
      doc.image(logo, L + 5, 18, { fit: [90, 44], align: 'center', valign: 'center' });
      tx = L + 112;
    } catch { /* sin logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(tenant.company_name || '', tx, 22, { width: 260 });
  doc.font('Helvetica').fontSize(8).fillColor('#ffffff').text([tenant.tax_id ? `NIT ${tenant.tax_id}` : null, tenant.phone, tenant.email].filter(Boolean).join(' · '), tx, 40, { width: 260 });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff').text('PROPUESTA SOLAR', L + W - 220, 20, { width: 220, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(`${study.number}${study.quote?.quote_number || study.quote?.sale_number ? ` · ${study.quote.quote_number || study.quote.sale_number}` : ''}`, L + W - 220, 42, { width: 220, align: 'right' });
  doc.text(new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' }), L + W - 220, 54, { width: 220, align: 'right' });

  let y = 98;
  const section = (title) => {
    if (y > doc.page.height - 140) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(accent).text(title.toUpperCase(), L, y);
    y = doc.y + 6;
  };
  const row = (label, value) => {
    doc.font('Helvetica').fontSize(9).fillColor(gray).text(label, L, y, { width: 170 });
    doc.font('Helvetica').fontSize(9.5).fillColor(black).text(value || '—', L + 175, y, { width: W - 175 });
    y = Math.max(doc.y, y + 12) + 3;
  };

  const c = study.customer;
  section('Cliente');
  row('Cliente', c ? (c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ')) : '—');
  row('Ubicación', [study.address, study.city, study.department].filter(Boolean).join(', '));
  row('Tipo de sistema', SYSTEM[study.system_type] || study.system_type);
  row('Consumo actual', `${int(study.monthly_kwh)} kWh/mes · tarifa ${cop(study.tariff_kwh)}/kWh`);

  y += 6;
  section('Sistema dimensionado');
  const boxes = [
    ['Potencia instalada', `${Number(r.kwp).toLocaleString('es-CO')} kWp`, `${r.panels} paneles de ${r.panel_watts} W`],
    ['Producción estimada', `${int(r.production_month)} kWh/mes`, `${int(r.production_year)} kWh/año`],
    ['Cobertura', `${r.coverage_pct} %`, 'del consumo mensual'],
    ['Radiación', `${Number(r.hsp).toLocaleString('es-CO')} HSP`, `eficiencia ${Math.round((r.pr || 0) * 100)} %`],
  ];
  const bw = (W - 18) / 4;
  boxes.forEach(([label, value, sub], i) => {
    const x = L + i * (bw + 6);
    doc.roundedRect(x, y, bw, 52, 5).fillAndStroke('#f9fafb', '#e5e7eb');
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(label, x + 8, y + 7, { width: bw - 16 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(value, x + 8, y + 19, { width: bw - 16 });
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(sub, x + 8, y + 36, { width: bw - 16 });
  });
  y += 64;

  // Producción mensual (barras)
  const prod = r.production_monthly || [];
  if (prod.length === 12) {
    const chartH = 90;
    const max = Math.max(...prod, Number(study.monthly_kwh) || 0) || 1;
    const barW = (W - 30) / 12;
    doc.font('Helvetica').fontSize(8).fillColor(gray).text('Producción mensual estimada (kWh) vs. consumo', L, y);
    y += 12;
    const base = y + chartH;
    prod.forEach((v, i) => {
      const h = (v / max) * chartH;
      doc.rect(L + 30 + i * barW + 3, base - h, barW - 6, h).fill(accent);
      doc.font('Helvetica').fontSize(6.5).fillColor(gray).text(MONTHS[i], L + 30 + i * barW, base + 3, { width: barW, align: 'center' });
    });
    const cy = base - ((Number(study.monthly_kwh) || 0) * (Number(r.coverage_pct) / 100 || 1) / max) * chartH;
    doc.moveTo(L + 30, cy).lineTo(L + W, cy).dash(3, { space: 3 }).strokeColor('#d97706').lineWidth(1).stroke().undash();
    doc.font('Helvetica').fontSize(6.5).fillColor('#d97706').text('consumo a cubrir', L, cy - 4, { width: 28 });
    y = base + 18;
  }

  section('Oferta económica');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(gray);
  doc.text('Concepto', L, y).text('Cant.', L + W - 200, y, { width: 40, align: 'right' }).text('Valor', L + W - 120, y, { width: 120, align: 'right' });
  y += 12;
  for (const l of r.lines || []) {
    if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
    doc.font('Helvetica').fontSize(9).fillColor(black).text(l.name, L, y, { width: W - 210 });
    const h = doc.y;
    doc.text(int(l.quantity), L + W - 200, y, { width: 40, align: 'right' }).text(cop(l.subtotal), L + W - 120, y, { width: 120, align: 'right' });
    y = Math.max(h, y + 12) + 3;
  }
  doc.moveTo(L, y).lineTo(L + W, y).strokeColor('#e5e7eb').lineWidth(0.8).stroke();
  y += 5;
  const totalRow = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(black)
      .text(label, L + W - 330, y, { width: 200, align: 'right' }).text(value, L + W - 120, y, { width: 120, align: 'right' });
    y += bold ? 16 : 13;
  };
  if (r.aiu) {
    totalRow('Costo directo', cop(r.direct));
    totalRow(`AIU (${r.aiu.admin_pct} % + ${r.aiu.unforeseen_pct} % + ${r.aiu.profit_pct} %)`, cop(r.aiu.total));
  }
  totalRow('Subtotal', cop(r.subtotal));
  totalRow('Impuestos (estimado)', cop(r.taxes));
  totalRow('Total inversión', cop(r.total), true);

  y += 6;
  section('Ahorro y retorno');
  row('Ahorro mensual estimado', cop(r.savings_month));
  row('Ahorro anual estimado', cop(r.savings_year));
  row('Retorno de la inversión', r.payback_months ? `${Number(r.payback_months).toLocaleString('es-CO')} meses (${(r.payback_months / 12).toLocaleString('es-CO', { maximumFractionDigits: 1 })} años)` : '—');
  row('Beneficio tributario', `Deducción en renta de hasta ${cop(r.tax_deduction_50)} (50 % de la inversión, Ley 1715 de 2014), sujeta a certificación UPME.`);

  const terms = settings.payment_terms || [];
  if (terms.length) {
    y += 6;
    section('Forma de pago');
    for (const t of terms) row(`${t.pct} % · ${t.label}`, cop((Number(r.total) || 0) * t.pct / 100));
  }
  if (settings.conditions) {
    y += 6;
    section('Condiciones');
    doc.font('Helvetica').fontSize(8.5).fillColor(black).text(settings.conditions, L, y, { width: W });
    y = doc.y + 6;
    row('Validez de la oferta', `${settings.validity_days} días calendario`);
  }
  // Pie dentro del margen inferior: sin esto pdfkit abre una página nueva.
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(7).fillColor(gray)
    .text('Radiación: NASA POWER (climatología). Valores estimados; la cotización formal liquida los impuestos exactos.', L, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
  doc.page.margins.bottom = bottomMargin;
  doc.end();
  return done;
}

module.exports = { generateSolarProposalPdf };
