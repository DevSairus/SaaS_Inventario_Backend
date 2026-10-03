// backend/src/services/purchaseOrderPdf.service.js
//
// PDF de la orden de compra para enviar al proveedor: empresa (logo, NIT,
// contacto), proveedor, condiciones (entrega, plazo, forma de pago, lugar de
// entrega), ítems con el código del proveedor cuando se conoce, totales,
// retenciones que se practicarán y neto a pagar, notas visibles (nunca las
// internas) y espacio de autorización. Mismo estilo visual que los demás
// PDF del sistema (franja roja, grises).

'use strict';

const PDFDocument = require('pdfkit');
const { downloadImageWithTimeout, toJpgUrl } = require('./pdfService');

const red = '#8b0000';
const gray = '#6b7280';
const darkGray = '#374151';
const softGray = '#f9fafb';
const border = '#e5e7eb';
const borderMd = '#d1d5db';
const black = '#111827';
const white = '#ffffff';

const money = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(n) || 0);
const fmtDate = (d) => {
  if (!d) return '—';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, m, day] = s.split('-');
  return y && m && day ? `${day}/${m}/${y}` : s;
};
const qty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toLocaleString('es-CO', { maximumFractionDigits: 2 });
};

const STATUS_LABEL = { draft: 'BORRADOR', confirmed: 'CONFIRMADA', partially_received: 'RECIBIDA PARCIAL', received: 'RECIBIDA', cancelled: 'CANCELADA' };
const RET_NAMES = { '07': 'ReteFuente', '05': 'ReteIVA', '06': 'ReteICA' };

/**
 * @param {object} purchase - con supplier, items (y product), warehouse/branch opcionales
 * @param {object} tenant
 * @param {object} opts - { supplierCodes: Map(product_id → código del proveedor), authorizedBy, deliveryPlace }
 * @returns {Promise<Buffer>}
 */
async function generatePurchaseOrderPDFBuffer(purchase, tenant, opts = {}) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const PAGE_W = doc.page.width;
  const MARGIN = 40;
  const INNER_W = PAGE_W - MARGIN * 2;
  const bottomLimit = doc.page.height - 70;
  const cfg = tenant?.dian_config || {};
  const company = cfg.company_name || tenant?.company_name || 'Empresa';
  const nit = cfg.nit ? `${cfg.nit}${cfg.dv ? '-' + cfg.dv : ''}` : (tenant?.tax_id || '');
  const supplier = purchase.supplier || {};

  doc.rect(0, 0, PAGE_W, 5).fill(red);
  let y = 18;

  // ── Encabezado: logo + empresa | título y número ──
  const HDR_H = 70;
  doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).fillAndStroke(softGray, borderMd);
  let textX = MARGIN + 12;
  if (tenant?.logo_url && String(tenant.logo_url).startsWith('http')) {
    try {
      const img = await downloadImageWithTimeout(toJpgUrl(tenant.logo_url));
      doc.image(img, MARGIN + 12, y + 13, { fit: [90, 44], align: 'left', valign: 'center' });
      textX = MARGIN + 112;
    } catch (e) { /* sin logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(black).text(company, textX, y + 12, { width: 250 });
  doc.font('Helvetica').fontSize(8).fillColor(gray)
    .text([nit && `NIT ${nit}`, tenant?.phone || cfg.phone].filter(Boolean).join('  ·  '), textX, y + 28, { width: 250 })
    .text([tenant?.address || cfg.address, cfg.city].filter(Boolean).join(', '), textX, y + 39, { width: 250 })
    .text(tenant?.email || cfg.email || '', textX, y + 50, { width: 250 });

  doc.font('Helvetica-Bold').fontSize(16).fillColor(red).text('ORDEN DE COMPRA', MARGIN, y + 12, { width: INNER_W - 14, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(black).text(purchase.purchase_number || '', MARGIN, y + 32, { width: INNER_W - 14, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text(`Fecha: ${fmtDate(purchase.purchase_date)}`, MARGIN, y + 50, { width: INNER_W - 14, align: 'right' });
  y += HDR_H + 10;

  if (['draft', 'cancelled'].includes(purchase.status)) {
    doc.save();
    doc.rotate(-30, { origin: [PAGE_W / 2, 400] });
    doc.font('Helvetica-Bold').fontSize(80).fillColor(purchase.status === 'cancelled' ? '#dc2626' : '#9ca3af').opacity(0.12)
      .text(STATUS_LABEL[purchase.status], 0, 360, { width: PAGE_W, align: 'center' });
    doc.restore();
    doc.opacity(1);
  }

  // ── Proveedor | Condiciones ──
  const half = (INNER_W - 10) / 2;
  const boxH = 92;
  const box = (x, title) => {
    doc.roundedRect(x, y, half, boxH, 4).strokeColor(border).lineWidth(0.7).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(gray).text(title, x + 10, y + 8);
  };
  box(MARGIN, 'PROVEEDOR');
  doc.font('Helvetica-Bold').fontSize(10).fillColor(black).text(supplier.business_name || supplier.name || '—', MARGIN + 10, y + 20, { width: half - 20 });
  doc.font('Helvetica').fontSize(8).fillColor(darkGray);
  const supLines = [
    supplier.tax_id && `NIT/CC: ${supplier.tax_id}`,
    supplier.contact_name && `Contacto: ${supplier.contact_name}`,
    [supplier.phone, supplier.mobile].filter(Boolean).join(' · '),
    supplier.email,
    [supplier.address, supplier.city].filter(Boolean).join(', '),
  ].filter(Boolean);
  supLines.slice(0, 5).forEach((l, i) => doc.text(l, MARGIN + 10, y + 36 + i * 10.5, { width: half - 20, ellipsis: true, lineBreak: false }));

  const cx = MARGIN + half + 10;
  box(cx, 'CONDICIONES');
  const terms = Number(purchase.payment_terms);
  const cond = [
    ['Entrega esperada', fmtDate(purchase.expected_delivery_date)],
    ['Plazo de pago', purchase.payment_terms === null || purchase.payment_terms === undefined ? '—' : (terms === 0 ? 'Contado' : `${terms} días`)],
    ['Forma de pago', purchase.payment_method || '—'],
    ['Lugar de entrega', opts.deliveryPlace || '—'],
    ['Referencia', purchase.reference || '—'],
  ];
  cond.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(8).fillColor(gray).text(k, cx + 10, y + 22 + i * 13, { width: 90 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(black).text(v, cx + 100, y + 22 + i * 13, { width: half - 110, ellipsis: true, lineBreak: false });
  });
  y += boxH + 14;

  // ── Ítems ──
  const COLS = [
    { key: 'n', label: '#', w: 18, align: 'left' },
    { key: 'code', label: 'CÓDIGO', w: 70, align: 'left' },
    { key: 'desc', label: 'DESCRIPCIÓN', w: 168, align: 'left' },
    { key: 'qty', label: 'CANT.', w: 40, align: 'right' },
    { key: 'unit', label: 'VR. UNIT.', w: 66, align: 'right' },
    { key: 'disc', label: 'DESC.', w: 34, align: 'right' },
    { key: 'iva', label: 'IVA', w: 30, align: 'right' },
    { key: 'total', label: 'SUBTOTAL', w: 0, align: 'right' },
  ];
  COLS[COLS.length - 1].w = INNER_W - COLS.slice(0, -1).reduce((s, c) => s + c.w, 0);

  const drawHeader = () => {
    doc.rect(MARGIN, y, INNER_W, 16).fill(darkGray);
    let x = MARGIN;
    for (const c of COLS) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(white).text(c.label, x + 4, y + 5, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    y += 18;
  };
  drawHeader();

  const codes = opts.supplierCodes || new Map();
  (purchase.items || []).forEach((it, idx) => {
    const desc = it.product_name || it.product?.name || '';
    const h = Math.max(14, doc.font('Helvetica').fontSize(8).heightOfString(desc, { width: COLS[2].w - 8 }) + 6);
    if (y + h > bottomLimit) {
      doc.addPage();
      doc.rect(0, 0, PAGE_W, 5).fill(red);
      y = 30;
      drawHeader();
    }
    if (idx % 2 === 1) doc.rect(MARGIN, y - 2, INNER_W, h).fill(softGray);
    const code = codes.get(it.product_id) || it.product_sku || it.product?.sku || '';
    const values = {
      n: String(idx + 1),
      // Código del proveedor y, debajo, el SKU propio si es distinto.
      code: code + (codes.get(it.product_id) && it.product_sku && String(it.product_sku) !== String(code) ? `\n(${it.product_sku})` : ''),
      desc,
      qty: qty(it.quantity),
      unit: money(it.unit_cost),
      disc: Number(it.discount_percentage) ? `${Number(it.discount_percentage)}%` : '—',
      iva: `${Number(it.tax_rate || 0)}%`,
      total: money(it.subtotal),
    };
    let x = MARGIN;
    for (const c of COLS) {
      doc.font(c.key === 'desc' ? 'Helvetica' : 'Helvetica').fontSize(c.key === 'code' ? 7 : 8).fillColor(black)
        .text(values[c.key], x + 4, y + 2, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    y += h;
  });
  doc.moveTo(MARGIN, y + 2).lineTo(MARGIN + INNER_W, y + 2).strokeColor(borderMd).lineWidth(0.5).stroke();
  y += 10;

  // ── Totales ──
  const totals = [
    ['Subtotal', purchase.subtotal],
    ...(Number(purchase.discount_amount) ? [['Descuento', -Number(purchase.discount_amount)]] : []),
    ['IVA', purchase.tax_amount],
    ...(Number(purchase.shipping_cost) ? [['Flete', purchase.shipping_cost]] : []),
  ];
  const lines = Array.isArray(purchase.applied_retentions) && purchase.applied_retentions.length
    ? purchase.applied_retentions.map((l) => [`${RET_NAMES[l.code] || l.code} ${l.concept && l.concept !== RET_NAMES[l.code] ? '· ' + l.concept + ' ' : ''}(${l.rate}${l.code === '06' ? '‰' : '%'})`, -Number(l.amount)])
    : [
      ...(Number(purchase.retefuente_amount) ? [[`ReteFuente (${Number(purchase.retefuente_rate)}%)`, -Number(purchase.retefuente_amount)]] : []),
      ...(Number(purchase.reteiva_amount) ? [[`ReteIVA (${Number(purchase.reteiva_rate)}%)`, -Number(purchase.reteiva_amount)]] : []),
      ...(Number(purchase.reteica_amount) ? [[`ReteICA (${Number(purchase.reteica_rate)}‰)`, -Number(purchase.reteica_amount)]] : []),
    ];
  const needed = 18 * (totals.length + lines.length + 3) + 90;
  if (y + needed > bottomLimit) {
    doc.addPage();
    doc.rect(0, 0, PAGE_W, 5).fill(red);
    y = 30;
  }
  const tx = MARGIN + INNER_W - 230;
  const row = (label, value, bold = false, color = black) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 8.5).fillColor(color)
      .text(label, tx, y, { width: 130 })
      .text(money(value), tx + 130, y, { width: 100, align: 'right' });
    y += bold ? 16 : 13;
  };
  const totalsTop = y;
  totals.forEach(([l, v]) => row(l, v));
  doc.moveTo(tx, y).lineTo(MARGIN + INNER_W, y).strokeColor(borderMd).lineWidth(0.5).stroke();
  y += 4;
  row('TOTAL', purchase.total_amount, true);
  if (lines.length) {
    lines.forEach(([l, v]) => row(l, v, false, '#c2410c'));
    doc.moveTo(tx, y).lineTo(MARGIN + INNER_W, y).strokeColor(borderMd).lineWidth(0.5).stroke();
    y += 4;
    row('NETO A PAGAR', Number(purchase.total_amount) - Number(purchase.total_retentions || 0), true, red);
  }

  // ── Notas (visibles; nunca internal_notes) ──
  let ny = totalsTop;
  if (purchase.notes) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(gray).text('OBSERVACIONES', MARGIN, ny);
    doc.font('Helvetica').fontSize(8).fillColor(darkGray).text(purchase.notes, MARGIN, ny + 11, { width: tx - MARGIN - 20 });
    ny = doc.y + 8;
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(
    `Favor citar el número de orden ${purchase.purchase_number} en la factura electrónica. `
    + (lines.length ? 'Las retenciones indicadas se practicarán al momento del pago, conforme a la normativa vigente.' : ''),
    MARGIN, Math.max(ny, totalsTop + (purchase.notes ? 0 : 0)), { width: tx - MARGIN - 20 }
  );

  // ── Autorización ──
  y = Math.max(y, doc.y) + 40;
  if (y + 40 > bottomLimit) { doc.addPage(); doc.rect(0, 0, PAGE_W, 5).fill(red); y = 80; }
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 200, y).strokeColor(darkGray).lineWidth(0.6).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(darkGray)
    .text(opts.authorizedBy ? `Autorizado por: ${opts.authorizedBy}` : 'Autorizado por', MARGIN, y + 4, { width: 200 })
    .text(company, MARGIN, y + 15, { width: 200 });

  // ── Pie con paginación ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i);
    // Sin margen inferior: el pie va dentro del margen y pdfkit, si no,
    // agrega una página en blanco por cada texto escrito ahí.
    doc.page.margins.bottom = 0;
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(red);
    doc.font('Helvetica').fontSize(7).fillColor(gray)
      .text(`${company} · Orden de compra ${purchase.purchase_number} · Página ${i + 1} de ${range.count}`, MARGIN, doc.page.height - 24, { width: INNER_W, align: 'center' });
  }
  doc.end();
  return done;
}

module.exports = { generatePurchaseOrderPDFBuffer };
