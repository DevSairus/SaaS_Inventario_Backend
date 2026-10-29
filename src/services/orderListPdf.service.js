// backend/src/services/orderListPdf.service.js
//
// PDF de la lista de pedido a proveedor: empresa, proveedor y las líneas con
// el código del proveedor cuando se conoce y la cantidad. Sin precios ni
// totales (no es una orden de compra). Mismo estilo visual que
// purchaseOrderPdf.service.js (franja roja, grises).

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

const STATUS_LABEL = { cancelled: 'DESCARTADO' };

/**
 * @param {object} list - con supplier e items (y product)
 * @param {object} tenant
 * @param {object} opts - { supplierCodes: Map(product_id → código del proveedor), requestedBy }
 * @returns {Promise<Buffer>}
 */
async function generateOrderListPDFBuffer(list, tenant, opts = {}) {
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
  const supplier = list.supplier || {};

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

  doc.font('Helvetica-Bold').fontSize(16).fillColor(red).text('PEDIDO', MARGIN, y + 12, { width: INNER_W - 14, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(black).text(list.list_number || '', MARGIN, y + 32, { width: INNER_W - 14, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(gray).text(`Fecha: ${fmtDate(list.ordered_at || new Date())}`, MARGIN, y + 50, { width: INNER_W - 14, align: 'right' });
  y += HDR_H + 10;

  if (STATUS_LABEL[list.status]) {
    doc.save();
    doc.rotate(-30, { origin: [PAGE_W / 2, 400] });
    doc.font('Helvetica-Bold').fontSize(80).fillColor('#dc2626').opacity(0.12)
      .text(STATUS_LABEL[list.status], 0, 360, { width: PAGE_W, align: 'center' });
    doc.restore();
    doc.opacity(1);
  }

  // ── Proveedor ──
  const boxH = 62;
  doc.roundedRect(MARGIN, y, INNER_W, boxH, 4).strokeColor(border).lineWidth(0.7).stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(gray).text('PROVEEDOR', MARGIN + 10, y + 8);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(black).text(supplier.business_name || supplier.name || '—', MARGIN + 10, y + 20, { width: INNER_W - 20 });
  doc.font('Helvetica').fontSize(8).fillColor(darkGray);
  const supLines = [
    [supplier.tax_id && `NIT/CC: ${supplier.tax_id}`, supplier.contact_name && `Contacto: ${supplier.contact_name}`].filter(Boolean).join('   ·   '),
    [supplier.phone, supplier.mobile, supplier.email].filter(Boolean).join('   ·   '),
  ].filter(Boolean);
  supLines.forEach((l, i) => doc.text(l, MARGIN + 10, y + 36 + i * 10.5, { width: INNER_W - 20, ellipsis: true, lineBreak: false }));
  y += boxH + 14;

  // ── Ítems ──
  const COLS = [
    { key: 'n', label: '#', w: 22, align: 'left' },
    { key: 'code', label: 'CÓDIGO', w: 90, align: 'left' },
    { key: 'desc', label: 'DESCRIPCIÓN', w: 0, align: 'left' },
    { key: 'unit', label: 'UNIDAD', w: 50, align: 'left' },
    { key: 'qty', label: 'CANTIDAD', w: 60, align: 'right' },
  ];
  COLS[2].w = INNER_W - COLS.reduce((s, c) => s + c.w, 0);

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
  (list.items || []).forEach((it, idx) => {
    const desc = (it.product?.name || it.description || '') + (it.notes ? `\n${it.notes}` : '');
    const h = Math.max(14, doc.font('Helvetica').fontSize(8).heightOfString(desc, { width: COLS[2].w - 8 }) + 6);
    if (y + h > bottomLimit) {
      doc.addPage();
      doc.rect(0, 0, PAGE_W, 5).fill(red);
      y = 30;
      drawHeader();
    }
    if (idx % 2 === 1) doc.rect(MARGIN, y - 2, INNER_W, h).fill(softGray);
    const sku = it.product?.sku || '';
    const code = codes.get(it.product_id) || sku;
    const values = {
      n: String(idx + 1),
      // Código del proveedor y, debajo, el SKU propio si es distinto.
      code: code + (codes.get(it.product_id) && sku && String(sku) !== String(code) ? `\n(${sku})` : ''),
      desc,
      unit: it.product?.unit_of_measure && it.product.unit_of_measure !== 'unit' ? it.product.unit_of_measure : 'Und',
      qty: qty(it.quantity),
    };
    let x = MARGIN;
    for (const c of COLS) {
      doc.font(c.key === 'qty' ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.key === 'code' ? 7 : 8).fillColor(black)
        .text(values[c.key], x + 4, y + 2, { width: c.w - 8, align: c.align });
      x += c.w;
    }
    y += h;
  });
  doc.moveTo(MARGIN, y + 2).lineTo(MARGIN + INNER_W, y + 2).strokeColor(borderMd).lineWidth(0.5).stroke();
  y += 14;

  // ── Observaciones ──
  if (list.notes) {
    if (y + 50 > bottomLimit) { doc.addPage(); doc.rect(0, 0, PAGE_W, 5).fill(red); y = 30; }
    doc.font('Helvetica-Bold').fontSize(7).fillColor(gray).text('OBSERVACIONES', MARGIN, y);
    doc.font('Helvetica').fontSize(8).fillColor(darkGray).text(list.notes, MARGIN, y + 11, { width: INNER_W });
    y = doc.y + 8;
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(
    'Por favor confirme disponibilidad, precios y tiempo de entrega de los ítems solicitados.',
    MARGIN, y, { width: INNER_W }
  );

  // ── Solicitado por ──
  y = doc.y + 40;
  if (y + 40 > bottomLimit) { doc.addPage(); doc.rect(0, 0, PAGE_W, 5).fill(red); y = 80; }
  doc.moveTo(MARGIN, y).lineTo(MARGIN + 200, y).strokeColor(darkGray).lineWidth(0.6).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(darkGray)
    .text(opts.requestedBy ? `Solicitado por: ${opts.requestedBy}` : 'Solicitado por', MARGIN, y + 4, { width: 200 })
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
      .text(`${company} · Pedido ${list.list_number} · Página ${i + 1} de ${range.count}`, MARGIN, doc.page.height - 24, { width: INNER_W, align: 'center' });
  }
  doc.end();
  return done;
}

module.exports = { generateOrderListPDFBuffer };
