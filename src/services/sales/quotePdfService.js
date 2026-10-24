// backend/src/services/sales/quotePdfService.js
// Formato propio de la COTIZACIÓN (Sale.document_type='cotizacion'). Antes
// se imprimía con el mismo formato de factura/remisión (pdfService.js) y, al
// estar en borrador, salía titulada "BORRADOR". Una cotización es una
// propuesta para el cliente, no un documento de venta: lleva vigencia,
// condiciones comerciales, estado de aprobación por ítem y un bloque para
// aceptarla (QR al link público o firma), y nada de pagos/saldos/DIAN.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { groupComboLines, collapseComboLinesForDian } = require('../../utils/comboLines');
const { taxLinesFromItems } = require('../taxService');
const {
  downloadImage, downloadImageWithTimeout, toJpgUrl, drawDiagnosisSection, formatCurrency,
} = require('../pdfService');

const QUOTE_STATUS = {
  borrador:  { label: 'BORRADOR',  color: '#6b7280' },
  enviada:   { label: 'PENDIENTE DE APROBACIÓN', color: '#2563eb' },
  aprobada:  { label: 'APROBADA',  color: '#059669' },
  parcial:   { label: 'APROBADA PARCIALMENTE', color: '#7c3aed' },
  rechazada: { label: 'RECHAZADA', color: '#dc2626' },
  vencida:   { label: 'VENCIDA',   color: '#d97706' },
};

const DEFAULT_TERMS = 'Precios sujetos a disponibilidad de inventario al momento de la aprobación. '
  + 'Esta cotización no constituye una factura de venta.';

const HEX = /^#?([0-9a-f]{6})$/i;
function accentOf(tenant) {
  const m = HEX.exec(String(tenant?.primary_color || '').trim());
  return m ? `#${m[1]}` : '#1e3a8a';
}
// Mezcla el color con blanco (t=0 → color, t=1 → blanco) para fondos suaves.
function tint(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * t);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// Fechas de solo día ('YYYY-MM-DD') se leen al mediodía: new Date() las toma
// como UTC y en Colombia mostraban el día anterior.
function fmtDay(value) {
  if (!value) return '—';
  const v = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  return new Date(v).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
}

function publicQuoteUrl(sale) {
  const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return sale.share_token && frontendUrl ? `${frontendUrl}/cotizacion/${sale.share_token}` : null;
}

const generateQuotePDFBuffer = async (sale, tenant) => {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const accent   = accentOf(tenant);
  const accentBg = tint(accent, 0.92);
  const gray     = '#6b7280';
  const darkGray = '#374151';
  const black    = '#111827';
  const border   = '#e5e7eb';
  const borderMd = '#d1d5db';
  const white    = '#ffffff';
  const red      = '#dc2626';

  const PAGE_W  = doc.page.width;
  const PAGE_H  = doc.page.height;
  const MARGIN  = 40;
  const INNER_W = PAGE_W - MARGIN * 2;
  const BOTTOM  = PAGE_H - 60; // deja espacio al pie de página
  const ensureSpace = (y, h) => {
    if (y + h <= BOTTOM) return y;
    doc.addPage();
    return 40;
  };

  /* ══ ENCABEZADO: banda de color con marca + título ═════════════ */
  const BAND_H = 86;
  doc.rect(0, 0, PAGE_W, BAND_H).fill(accent);

  let textX = MARGIN;
  if (tenant.logo_url && tenant.logo_url.startsWith('http')) {
    try {
      const logo = await downloadImage(tenant.logo_url);
      // Recuadro blanco: el logo del tenant suele estar pensado para fondo claro.
      doc.roundedRect(MARGIN, 16, 108, 54, 6).fill(white);
      doc.image(logo, MARGIN + 6, 20, { fit: [96, 46], align: 'center', valign: 'center' });
      textX = MARGIN + 122;
    } catch { /* sin logo */ }
  }
  const TITLE_W = 190;
  const companyW = PAGE_W - MARGIN - TITLE_W - textX - 10;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(white)
    .text(tenant.company_name || 'Empresa', textX, 20, { width: companyW, ellipsis: true, lineBreak: false });
  const companyLines = [
    tenant.tax_id ? `NIT ${tenant.tax_id}` : null,
    tenant.address,
    [tenant.phone, tenant.email].filter(Boolean).join('  ·  '),
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5).fillColor(tint(accent, 0.75));
  companyLines.forEach((line, i) => doc.text(line, textX, 38 + i * 10, { width: companyW, ellipsis: true, lineBreak: false }));

  const TX = PAGE_W - MARGIN - TITLE_W;
  doc.font('Helvetica-Bold').fontSize(22).fillColor(white).text('COTIZACIÓN', TX, 18, { width: TITLE_W, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(white).text(sale.sale_number || '', TX, 46, { width: TITLE_W, align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor(tint(accent, 0.75))
    .text(`Emitida el ${fmtDay(sale.sale_date || sale.created_at)}`, TX, 61, { width: TITLE_W, align: 'right' });

  /* ══ TARJETAS: cliente · detalles · estado ════════════════════ */
  let y = BAND_H + 18;
  const CARD_H = 82;
  const GAP = 10;
  const cardW = (INNER_W - GAP * 2) / 3;
  const card = (i, title) => {
    const x = MARGIN + i * (cardW + GAP);
    doc.roundedRect(x, y, cardW, CARD_H, 6).fillAndStroke(accentBg, tint(accent, 0.8));
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(accent).text(title, x + 10, y + 9, { width: cardW - 20, characterSpacing: 0.6 });
    return x + 10;
  };

  // Cliente
  let cx = card(0, 'PREPARADA PARA');
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(black).text(sale.customer_name || 'Cliente', cx, y + 22, { width: cardW - 20, height: 12, ellipsis: true });
  doc.font('Helvetica').fontSize(7.5).fillColor(darkGray);
  [
    sale.customer_tax_id ? `Doc. ${sale.customer_tax_id}` : null,
    sale.customer?.phone || sale.customer_phone,
    sale.customer?.email || sale.customer_email,
    sale.customer?.address || sale.customer_address,
  ].filter(Boolean).slice(0, 4).forEach((line, i) => doc.text(String(line), cx, y + 36 + i * 10.5, { width: cardW - 20, height: 10, ellipsis: true }));

  // Detalles
  cx = card(1, 'DETALLES');
  const vehicle = [sale.vehicle_brand, sale.vehicle_model, sale.vehicle_year].filter(Boolean).join(' ');
  const details = [
    ['Válida hasta', sale.quote_valid_until ? fmtDay(String(sale.quote_valid_until).slice(0, 10)) : '—'],
    sale.vehicle_plate ? ['Placa', sale.vehicle_plate] : null,
    vehicle ? ['Vehículo', vehicle] : null,
    sale.mileage ? ['Kilometraje', Number(sale.mileage).toLocaleString('es-CO')] : null,
    sale.technician_name ? ['Asesor', sale.technician_name] : null,
  ].filter(Boolean).slice(0, 4);
  details.forEach(([label, value], i) => {
    const ly = y + 22 + i * 13.5;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(label, cx, ly, { width: 58, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(black).text(String(value), cx + 60, ly, { width: cardW - 80, height: 10, ellipsis: true });
  });

  // Estado
  cx = card(2, 'ESTADO');
  const st = QUOTE_STATUS[sale.quote_status] || QUOTE_STATUS.borrador;
  doc.roundedRect(cx, y + 24, cardW - 20, 20, 10).fill(st.color);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white).text(st.label, cx, y + 30, { width: cardW - 20, align: 'center', lineBreak: false });
  if (sale.quote_responded_at && ['aprobada', 'parcial', 'rechazada'].includes(sale.quote_status)) {
    doc.font('Helvetica').fontSize(7).fillColor(darkGray)
      .text(`${sale.quote_approved_by_name || ''}`, cx, y + 52, { width: cardW - 20, align: 'center', ellipsis: true, lineBreak: false })
      .text(fmtDay(sale.quote_responded_at), cx, y + 63, { width: cardW - 20, align: 'center', lineBreak: false });
  } else {
    doc.font('Helvetica').fontSize(7).fillColor(darkGray)
      .text('Total cotizado', cx, y + 52, { width: cardW - 20, align: 'center', lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(black)
      .text(formatCurrency(sale.total_amount), cx, y + 62, { width: cardW - 20, align: 'center', lineBreak: false });
  }

  y += CARD_H + 20;

  /* ══ ÍTEMS ═════════════════════════════════════════════════════ */
  const items = sale.items || sale.SaleItems || [];
  const images = {};
  await Promise.all(items.map(async (item) => {
    const url = item.product?.image_url || item.Product?.image_url;
    if (!url) return;
    try { images[item.id] = await downloadImageWithTimeout(toJpgUrl(url)); } catch { /* fila sin imagen */ }
  }));
  const hasImages = Object.keys(images).length > 0;

  const COL = {
    num:   { x: MARGIN,       w: 22 },
    desc:  { x: MARGIN + 22,  w: 236 },
    qty:   { x: MARGIN + 258, w: 40 },
    price: { x: MARGIN + 298, w: 78 },
    disc:  { x: MARGIN + 376, w: 40 },
    tax:   { x: MARGIN + 416, w: 36 },
    total: { x: MARGIN + 452, w: INNER_W - 452 },
  };
  const drawTableHeader = () => {
    doc.rect(MARGIN, y, INNER_W, 20).fill(accent);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white);
    doc.text('#', COL.num.x, y + 6.5, { width: COL.num.w, align: 'center' });
    doc.text('DESCRIPCIÓN', COL.desc.x + 6, y + 6.5, { width: COL.desc.w - 6 });
    doc.text('CANT.', COL.qty.x, y + 6.5, { width: COL.qty.w, align: 'center' });
    doc.text('VR. UNITARIO', COL.price.x, y + 6.5, { width: COL.price.w - 6, align: 'right' });
    doc.text('DESC.', COL.disc.x, y + 6.5, { width: COL.disc.w, align: 'center' });
    doc.text('IMP.', COL.tax.x, y + 6.5, { width: COL.tax.w, align: 'center' });
    doc.text('TOTAL', COL.total.x, y + 6.5, { width: COL.total.w - 8, align: 'right' });
    y += 20;
  };
  drawTableHeader();

  const rows = [];
  for (const entry of groupComboLines(items)) {
    if (entry.type === 'line') rows.push({ item: entry.item });
    else if (!entry.showBreakdown) collapseComboLinesForDian(entry.items).forEach(item => rows.push({ item }));
    else {
      rows.push({ comboHeader: entry });
      entry.items.forEach(item => rows.push({ item, component: true }));
    }
  }

  let lineNo = 0;
  // approval_status nace en 'aprobado' por defecto: solo se muestra cuando
  // el cliente ya respondió la cotización.
  const anyResponded = ['aprobada', 'parcial', 'rechazada'].includes(sale.quote_status);
  rows.forEach(({ item, comboHeader, component }) => {
    if (comboHeader) {
      const nextY = ensureSpace(y, 18);
      if (nextY !== y) { y = nextY; drawTableHeader(); }
      doc.rect(MARGIN, y, INNER_W, 18).fill(accentBg);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(black)
        .text(`Combo: ${comboHeader.name}`, COL.desc.x + 6, y + 5, { width: COL.desc.w + COL.qty.w })
        .text(formatCurrency(comboHeader.total), COL.total.x, y + 5, { width: COL.total.w - 8, align: 'right' });
      y += 18;
      return;
    }

    const rejected = anyResponded && item.approval_status === 'rechazado';
    const thumb = images[item.id];
    const descX = COL.desc.x + 6 + (thumb ? 40 : 0) + (component ? 10 : 0);
    const descW = COL.desc.x + COL.desc.w - descX - 4;
    const name = `${component ? '– ' : ''}${item.product?.name || item.Product?.name || item.product_name || item.description || ''}`;
    doc.font('Helvetica').fontSize(8.5);
    const nameH = doc.heightOfString(name, { width: descW });
    const subLine = [item.product_sku || item.product?.sku, anyResponded && item.approval_status === 'aprobado' ? 'Aprobado' : null, rejected ? 'Rechazado por el cliente' : null]
      .filter(Boolean).join(' · ');
    const textH = nameH + (subLine ? 10 : 0);
    const rowH = Math.max(hasImages ? 44 : 22, textH + 10);

    const nextY = ensureSpace(y, rowH);
    if (nextY !== y) { y = nextY; drawTableHeader(); }

    lineNo += component ? 0 : 1;
    const ty = y + (rowH - textH) / 2;
    const fg = rejected ? '#9ca3af' : black;
    if (thumb) {
      try { doc.image(thumb, COL.desc.x + 6, y + (rowH - 34) / 2, { fit: [34, 34] }); } catch { /* formato no soportado */ }
    }
    doc.font('Helvetica').fontSize(8).fillColor(gray)
      .text(component ? '' : String(lineNo), COL.num.x, ty, { width: COL.num.w, align: 'center' });
    doc.font('Helvetica').fontSize(8.5).fillColor(fg).text(name, descX, ty, { width: descW });
    if (subLine) {
      doc.font('Helvetica').fontSize(6.5).fillColor(rejected ? red : gray).text(subLine, descX, ty + nameH + 1, { width: descW, lineBreak: false, ellipsis: true });
    }
    const vy = y + (rowH - 9) / 2;
    const discPct = parseFloat(item.discount_percentage) || 0;
    const taxPct = parseFloat(item.tax_percentage) || 0;
    const incPct = parseFloat(item.inc_rate) || 0;
    doc.font('Helvetica').fontSize(8.5).fillColor(fg)
      .text(String(parseFloat(item.quantity) || 0), COL.qty.x, vy, { width: COL.qty.w, align: 'center' })
      .text(formatCurrency(item.unit_price), COL.price.x, vy, { width: COL.price.w - 6, align: 'right' })
      .text(discPct ? `${discPct}%` : '—', COL.disc.x, vy, { width: COL.disc.w, align: 'center' })
      .text(taxPct ? `${taxPct}%` : (item.iva_status === 'excluido' ? 'Excl.' : 'Exento'), COL.tax.x, vy - (incPct ? 4 : 0), { width: COL.tax.w, align: 'center' });
    // Impoconsumo de la línea, debajo del IVA.
    if (incPct) doc.font('Helvetica').fontSize(6.4).fillColor(rejected ? '#9ca3af' : gray)
      .text(`INC ${incPct}%`, COL.tax.x - 4, vy + (taxPct ? 6 : 1), { width: COL.tax.w + 8, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(fg)
      .text(formatCurrency(item.total), COL.total.x, vy, { width: COL.total.w - 8, align: 'right' });
    if (rejected) {
      doc.moveTo(COL.total.x + 8, vy + 4.5).lineTo(COL.total.x + COL.total.w - 8, vy + 4.5).strokeColor('#9ca3af').lineWidth(0.6).stroke();
    }
    doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + INNER_W, y + rowH).strokeColor(border).lineWidth(0.5).stroke();
    y += rowH;
  });

  /* ══ CONDICIONES (izq) + TOTALES (der) ════════════════════════ */
  const totals = [];
  if (sale.aiu_enabled) {
    totals.push(['Costo directo', formatCurrency(sale.aiu_direct_amount)]);
    totals.push([`Administración ${Number(sale.aiu_admin_pct)}%`, formatCurrency(sale.aiu_admin_amount)]);
    totals.push([`Imprevistos ${Number(sale.aiu_unforeseen_pct)}%`, formatCurrency(sale.aiu_unforeseen_amount)]);
    totals.push([`Utilidad ${Number(sale.aiu_profit_pct)}%`, formatCurrency(sale.aiu_profit_amount)]);
  }
  // Totales sobre lo que cuenta (lo rechazado por el cliente se ve tachado
  // arriba pero no suma). Impuestos desde las líneas, misma fuente que el
  // total; AIU conserva su desglose (IVA solo sobre la utilidad).
  const billable = items.filter(i => i.approval_status !== 'rechazado');
  const num = (v) => parseFloat(v) || 0;
  const lineDiscounts = billable.reduce((s, i) => s + num(i.discount_amount), 0);
  const netBase = billable.reduce((s, i) => s + num(i.total) - num(i.tax_amount) - num(i.inc_amount), 0);
  if (sale.aiu_enabled) totals.push(['Subtotal', formatCurrency(sale.subtotal)]);
  else {
    totals.push(['Subtotal', formatCurrency(netBase + lineDiscounts)]);
    if (lineDiscounts > 0) totals.push(['Descuentos', `- ${formatCurrency(lineDiscounts)}`]);
  }
  const taxes = sale.aiu_enabled ? (sale.tax_breakdown || []).filter(t => t.type === 'tax') : taxLinesFromItems(billable);
  taxes.forEach(t => totals.push([
    sale.aiu_enabled && t.code === '01' ? 'IVA s/ Utilidad' : `${t.code === '04' ? 'INC (impoconsumo)' : t.name} ${Number(t.rate)}%`,
    formatCurrency(t.amount),
  ]));
  if ((parseFloat(sale.global_discount_amount) || 0) > 0) totals.push(['Descuento global', `- ${formatCurrency(sale.global_discount_amount)}`]);

  const pdfConfig = tenant.pdf_config || {};
  const validity = sale.quote_valid_until
    ? `Oferta válida hasta el ${fmtDay(String(sale.quote_valid_until).slice(0, 10))}.`
    : null;
  const terms = [validity, pdfConfig.quote_terms?.trim() || DEFAULT_TERMS, pdfConfig.payment_notes?.trim()].filter(Boolean).join('\n\n');

  const TOT_W = 214;
  const TOT_X = MARGIN + INNER_W - TOT_W;
  const COND_W = INNER_W - TOT_W - 14;
  doc.font('Helvetica').fontSize(7.5);
  const termsH = doc.heightOfString(terms, { width: COND_W - 20 });
  const totalsH = totals.length * 15 + 12 + 34;
  const blockH = Math.max(totalsH, termsH + 30);

  y = ensureSpace(y + 16, blockH);
  doc.roundedRect(MARGIN, y, COND_W, blockH, 6).strokeColor(borderMd).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(accent).text('CONDICIONES COMERCIALES', MARGIN + 10, y + 10, { characterSpacing: 0.6 });
  doc.font('Helvetica').fontSize(7.5).fillColor(darkGray).text(terms, MARGIN + 10, y + 23, { width: COND_W - 20 });

  let ty = y + 10;
  totals.forEach(([label, value]) => {
    doc.font('Helvetica').fontSize(8.5).fillColor(darkGray)
      .text(label, TOT_X + 4, ty, { width: TOT_W - 100 })
      .text(value, TOT_X + TOT_W - 104, ty, { width: 100, align: 'right' });
    ty += 15;
  });
  const grandY = y + blockH - 34;
  doc.roundedRect(TOT_X, grandY, TOT_W, 34, 6).fill(accent);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(tint(accent, 0.75)).text('TOTAL COTIZADO', TOT_X + 12, grandY + 13);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(white).text(formatCurrency(sale.total_amount), TOT_X + 90, grandY + 10, { width: TOT_W - 102, align: 'right' });
  y += blockH;

  /* ══ OBSERVACIONES ═════════════════════════════════════════════ */
  if (sale.notes?.trim()) {
    doc.font('Helvetica').fontSize(8.5);
    const notesH = doc.heightOfString(sale.notes.trim(), { width: INNER_W });
    y = ensureSpace(y + 18, notesH + 16);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(accent).text('OBSERVACIONES', MARGIN, y, { characterSpacing: 0.6 });
    doc.font('Helvetica').fontSize(8.5).fillColor(black).text(sale.notes.trim(), MARGIN, y + 12, { width: INNER_W });
    y = doc.y;
  }

  /* ══ DIAGRAMA DE INTERVENCIÓN ══════════════════════════════════ */
  y = await drawDiagnosisSection(doc, sale, y, { MARGIN, INNER_W, gray, black, border });

  /* ══ ACEPTACIÓN ════════════════════════════════════════════════ */
  y = ensureSpace(y + 22, 96);
  const responded = ['aprobada', 'parcial', 'rechazada'].includes(sale.quote_status);
  if (responded) {
    doc.roundedRect(MARGIN, y, INNER_W, 50, 6).fillAndStroke(tint(st.color, 0.9), tint(st.color, 0.6));
    const verb = sale.quote_status === 'rechazada' ? 'Rechazada' : sale.quote_status === 'parcial' ? 'Aprobada parcialmente' : 'Aprobada';
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(st.color)
      .text(`${verb} por ${sale.quote_approved_by_name || 'el cliente'}`, MARGIN + 14, y + 12, { width: INNER_W - 28 });
    doc.font('Helvetica').fontSize(7.5).fillColor(darkGray).text(
      [sale.quote_approved_by_document ? `Documento ${sale.quote_approved_by_document}` : null,
        sale.quote_responded_at ? `el ${new Date(sale.quote_responded_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}` : null].filter(Boolean).join(' · '),
      MARGIN + 14, y + 28, { width: INNER_W - 28 }
    );
    y += 50;
  } else {
    const url = publicQuoteUrl(sale);
    const QR = 78;
    let sigX = MARGIN;
    if (url) {
      try {
        const qr = await QRCode.toDataURL(url, { margin: 1, width: QR * 4, color: { dark: accent } });
        doc.image(Buffer.from(qr.split(',')[1], 'base64'), MARGIN, y, { fit: [QR, QR] });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(black).text('Apruébala en línea', MARGIN + QR + 10, y + 14, { width: 150 });
        doc.font('Helvetica').fontSize(7.5).fillColor(gray)
          .text('Escanea el código para revisar cada ítem y aprobar o rechazar la cotización desde tu celular.', MARGIN + QR + 10, y + 28, { width: 150 });
        sigX = MARGIN + QR + 180;
      } catch { /* sin QR, solo firma */ }
    }
    const sigW = MARGIN + INNER_W - sigX;
    const half = (sigW - 16) / 2;
    const sigLine = (x, ly, w, label) => {
      doc.moveTo(x, ly).lineTo(x + w, ly).strokeColor(borderMd).lineWidth(0.6).stroke();
      doc.font('Helvetica').fontSize(6.5).fillColor(gray).text(label, x, ly + 3, { width: w });
    };
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(accent).text('ACEPTACIÓN DEL CLIENTE', sigX, y + 2, { characterSpacing: 0.6 });
    sigLine(sigX, y + 40, sigW, 'Firma');
    sigLine(sigX, y + 72, half, 'Nombre y documento');
    sigLine(sigX + half + 16, y + 72, half, 'Fecha');
    y += 90;
  }

  /* ══ PIE DE PÁGINA ═════════════════════════════════════════════ */
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // pie dentro del margen: sin esto pdfkit agrega páginas en blanco
    doc.moveTo(MARGIN, PAGE_H - 34).lineTo(MARGIN + INNER_W, PAGE_H - 34).strokeColor(border).lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(6.5).fillColor(gray)
      .text(`Cotización ${sale.sale_number || ''} · ${tenant.company_name || ''} · Este documento no es una factura de venta`, MARGIN, PAGE_H - 26, { width: INNER_W - 80, lineBreak: false })
      .text(`Página ${i + 1} de ${range.count}`, MARGIN + INNER_W - 80, PAGE_H - 26, { width: 80, align: 'right', lineBreak: false });
    doc.rect(0, PAGE_H - 4, PAGE_W, 4).fill(accent);
  }

  doc.end();
  return done;
};

module.exports = { generateQuotePDFBuffer };
