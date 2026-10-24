// backend/src/services/sales/salePremiumPdfService.js
// Representación gráfica de FACTURA y REMISIÓN (pdfService.generateSalePDF
// delega aquí para esos dos tipos). Organización tomada de "FacturaModelo"
// (encabezado con resolución DIAN, datos del cliente y facturación, ficha
// técnica del vehículo, tabla con código y tipo de concepto, monto en letras,
// totales con base gravable/retenciones y CUFE) con el estilo de
// "Factura_Premium_v4" / "Remision_Premium_v4" (00 - Documentación): logo y
// título grandes, etiquetas pequeñas en mayúscula, líneas finas y acento
// verde azulado.
//
// Lo que depende del tenant se respeta tal cual lo configura:
//   - Vehículo / Ref. taller: solo con el módulo Taller o el campo de vehículo
//     de ventas activo (features.vehicle_field_enabled), y si hay datos.
//   - Técnico: features.technician_field_enabled.
//   - IVA oculto: features.hide_remision_tax (remisión) / hide_invoice_tax.
//   - Textos: pdf_config.payment_notes, legal_note, warranty_note.
//   - Responsable de IVA: dian_config.tax_level_code; CIIU: actividad ICA por
//     defecto (si el tenant configuró ICA).
//   - Color: primary_color del tenant en los elementos de marca (franja
//     superior, números de ítem, línea del total, recuadro DIAN). "Pagado"
//     sigue en verde: es un estado, no marca.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { groupComboLines, collapseComboLinesForDian } = require('../../utils/comboLines');
const { amountInWords } = require('../../utils/numberToWords');
const { saleBalance } = require('../../utils/saleAmounts');
const { taxLinesFromItems } = require('../taxService');

const C = {
  ink: '#111827',
  slate: '#334155',
  muted: '#64748b',
  line: '#d8dfe8',
  soft: '#f4f6f9',
  paid: '#12a8a0',
  amber: '#d97706',
  orange: '#ea580c',
  red: '#dc2626',
  white: '#ffffff',
};

const DOC_TYPES = { '13': 'CC', '31': 'NIT', '12': 'TI', '11': 'RC', '21': 'TE', '22': 'CE', '41': 'Pasaporte', '42': 'Doc. extranjero', '47': 'PEP', '91': 'NUIP' };
const METHODS = {
  cash: 'Efectivo', efectivo: 'Efectivo', transfer: 'Transferencia', transferencia: 'Transferencia',
  credit_card: 'Tarjeta crédito', debit_card: 'Tarjeta débito', tarjeta: 'Tarjeta', check: 'Cheque',
  mixed: 'Pago mixto', credito: 'Crédito', advance: 'Anticipo', anticipo: 'Anticipo', other: 'Otro',
};
const ITEM_TAGS = { service: 'Servicio', product: 'Repuesto', free_line: 'Concepto' };

// Color de marca del tenant (verde azulado de la referencia si no tiene uno
// válido). Un color muy claro se oscurece para que los números y líneas se
// sigan leyendo sobre blanco.
function brandColor(tenant) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(tenant?.primary_color || '').trim());
  if (!m) return '#12a8a0';
  let [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (luminance > 0.62) {
    const k = 0.62 / luminance;
    [r, g, b] = [r, g, b].map(c => Math.round(c * k));
  }
  return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

const COP = (v) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(v) || 0);
// Fechas de solo día ('YYYY-MM-DD') al mediodía para no correr un día por zona horaria.
const day = (v) => {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
};
const n = (v) => Number(v) || 0;

// ── Datos auxiliares (cada consulta es opcional: si falla, el PDF sale igual) ──
async function loadContext(sale, tenant) {
  const models = require('../../models');
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  let items = sale.items || sale.SaleItems;
  if (!items) {
    items = await safe(() => models.SaleItem.findAll({
      where: { sale_id: sale.id },
      include: [{ model: models.Product, as: 'product', include: [{ model: models.Vehicle, as: 'vehicle' }] }],
    })) || [];
  }

  const modules = await safe(() => require('../moduleAccess').getEffectiveModulesForTenantId(tenant.id)) || [];
  const workshopEnabled = modules.includes('workshop');

  const workOrder = workshopEnabled
    ? await safe(() => models.WorkOrder.findOne({ where: { sale_id: sale.id }, attributes: ['order_number'] }))
    : null;

  const serviceVehicle = sale.vehicle_plate
    ? await safe(() => models.Vehicle.findOne({ where: { tenant_id: sale.tenant_id, plate: String(sale.vehicle_plate).toUpperCase().trim() } }))
    : null;

  // Resolución de la factura: la de prefijo más largo que coincida con el número.
  let resolution = null;
  if (sale.document_type === 'factura') {
    const all = await safe(() => models.DianResolution.findAll({ where: { tenant_id: sale.tenant_id, document_type: 'invoice' } })) || [];
    const number = String(sale.dian_invoice_number || sale.sale_number || '');
    resolution = all
      .filter(r => (r.prefix || '') && number.startsWith(r.prefix))
      .sort((a, b) => (b.prefix || '').length - (a.prefix || '').length || (b.is_active - a.is_active))[0]
      || all.find(r => r.is_active) || null;
  }

  const icaActivity = await safe(() => models.IcaActivity?.findOne({ where: { tenant_id: sale.tenant_id, is_default: true } }));

  return { items, workshopEnabled, workOrder, serviceVehicle, resolution, icaActivity };
}

function buildDianQrContent(sale, tenant) {
  const fecha = sale.dian_accepted_at || sale.sale_date || sale.created_at;
  const d = fecha ? new Date(fecha) : new Date();
  const ivaTotal = (sale.tax_breakdown || []).filter(t => t.type === 'tax' && t.code === '01').reduce((s, t) => s + n(t.amount), 0) || n(sale.tax_amount);
  const otherTaxes = (sale.tax_breakdown || []).filter(t => t.type === 'tax' && t.code !== '01').reduce((s, t) => s + n(t.amount), 0);
  const isProd = (tenant.dian_config?.environment || '').toString() === '1';
  const base = isProd ? 'https://catalogo-vpfe.dian.gov.co/document/searchqr' : 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr';
  return [
    `NumFac: ${sale.dian_invoice_number || sale.sale_number}`,
    `FecFac: ${d.toISOString().slice(0, 10)}`,
    `HorFac: ${d.toISOString().slice(11, 19)}-05:00`,
    `NitFac: ${tenant.dian_config?.nit || tenant.tax_id || ''}`,
    `DocAdq: ${sale.customer_tax_id || ''}`,
    `ValFac: ${n(sale.subtotal).toFixed(2)}`,
    `ValIva: ${ivaTotal.toFixed(2)}`,
    `ValOtroIm: ${otherTaxes.toFixed(2)}`,
    `ValTolFac: ${n(sale.total_amount).toFixed(2)}`,
    `CUFE: ${sale.cufe}`,
    `${base}?documentkey=${sale.cufe}`,
  ].join('\n');
}

async function generatePremiumSalePDFBuffer(sale, tenant, { downloadImage, drawDiagnosisSection }) {
  const ctx = await loadContext(sale, tenant);
  const features = tenant.features || {};
  const pdfConfig = tenant.pdf_config || {};
  const isInvoice = sale.document_type === 'factura';
  const brand = brandColor(tenant);
  const hideTax = isInvoice ? !!features.hide_invoice_tax : features.hide_remision_tax !== false;

  const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const M = 54;
  const W = PAGE_W - M * 2;
  const BOTTOM = PAGE_H - 70;
  let y = 42;

  const hr = (yy, x1 = M, x2 = M + W, color = C.line, width = 0.6) =>
    doc.moveTo(x1, yy).lineTo(x2, yy).strokeColor(color).lineWidth(width).stroke();
  const label = (text, x, yy, opts = {}) =>
    doc.font('Helvetica-Bold').fontSize(6.8).fillColor(C.muted).text(String(text).toUpperCase(), x, yy, { characterSpacing: 0.4, ...opts });
  const newPage = () => { doc.addPage(); y = 54; };
  const ensure = (h) => { if (y + h > BOTTOM) { newPage(); return true; } return false; };
  const section = (title, needed = 40) => {
    ensure(needed + 22);
    label(title, M, y);
    y += 11;
    hr(y);
    y += 10;
  };

  /* ═══ ENCABEZADO ═════════════════════════════════════════════════ */
  let leftY = y;
  if (tenant.logo_url && String(tenant.logo_url).startsWith('http')) {
    try {
      const logo = await downloadImage(tenant.logo_url);
      doc.image(logo, M, y, { fit: [112, 72], align: 'left', valign: 'top' });
      leftY = y + 80;
    } catch { /* sin logo */ }
  }
  const HDR_LEFT_W = W - 220;
  // Como en FacturaModelo: razón social grande y, debajo, el nombre comercial
  // (Ajustes: "Razón Social" = business_name, "Nombre Comercial" = company_name).
  const legalName = String(tenant.business_name || '').trim() || tenant.company_name || 'Empresa';
  const tradeName = String(tenant.company_name || '').trim();
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(C.ink).text(legalName, M, leftY, { width: HDR_LEFT_W });
  if (tradeName && tradeName.toUpperCase() !== legalName.toUpperCase()) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.slate).text(tradeName.toUpperCase(), M, doc.y + 1, { width: HDR_LEFT_W });
  }
  const levelCode = tenant.dian_config?.tax_level_code;
  const ivaRegime = levelCode ? (levelCode === 'R-99-PN' ? 'No responsable de IVA' : 'Responsable de IVA') : null;
  const nit = tenant.tax_id ? `NIT ${tenant.tax_id}${tenant.dian_config?.dv && !String(tenant.tax_id).includes('-') ? `-${tenant.dian_config.dv}` : ''}` : null;
  doc.font('Helvetica').fontSize(8.2).fillColor(C.muted);
  [
    [nit, ivaRegime].filter(Boolean).join('  ·  '),
    tenant.address,
    [tenant.phone ? `Tel/WhatsApp ${tenant.phone}` : null, tenant.email].filter(Boolean).join('  ·  '),
  ].filter(Boolean).forEach(line => doc.text(line, M, doc.y + 1, { width: HDR_LEFT_W }));
  const leftBottom = doc.y;

  // Derecha: título, número, emisión y (factura) resolución DIAN.
  const RX = M + W - 230;
  const RW = 230;
  const title = isInvoice ? 'FACTURA' : 'REMISIÓN';
  doc.font('Helvetica-Bold').fontSize(27).fillColor(C.ink).text(title, RX, y, { width: RW, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(C.muted)
    .text(isInvoice ? 'Factura electrónica de venta' : 'Documento de entrega', RX, doc.y - 2, { width: RW, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.muted).text(sale.dian_invoice_number || sale.sale_number || '', RX, doc.y + 2, { width: RW, align: 'right' });
  doc.font('Helvetica').fontSize(8.2).fillColor(C.muted).text(`EMISIÓN · ${day(sale.sale_date || sale.created_at)}`, RX, doc.y + 3, { width: RW, align: 'right' });
  if (isInvoice && ctx.resolution) {
    const r = ctx.resolution;
    const months = r.valid_from && r.valid_to
      ? Math.max(1, Math.round((new Date(r.valid_to) - new Date(r.valid_from)) / (30.44 * 86400000)))
      : null;
    doc.font('Helvetica').fontSize(6.8).fillColor(C.muted)
      .text(`Res. DIAN N° ${r.resolution_number}${r.resolution_date ? ` del ${day(r.resolution_date)}` : ''}`, RX, doc.y + 5, { width: RW, align: 'right' })
      .text(`Rango ${r.prefix || ''}${r.from_number} a ${r.prefix || ''}${r.to_number}${months ? ` · vigencia ${months} meses` : ''}`, RX, doc.y + 1, { width: RW, align: 'right' });
    if (r.is_test) doc.fillColor(C.amber).text('Resolución de pruebas (habilitación)', RX, doc.y + 1, { width: RW, align: 'right' });
  }
  y = Math.max(leftBottom, doc.y) + 22;

  /* ═══ 1. DATOS DEL CLIENTE Y FACTURACIÓN ═════════════════════════ */
  const balance = saleBalance(sale);
  const status = sale.status === 'cancelled'
    ? { text: 'ANULADA', color: C.red, sub: 'Documento anulado' }
    : sale.payment_status === 'paid'
      ? { text: 'PAGADO', color: C.paid, sub: 'Documento cancelado' }
      : sale.payment_status === 'partial'
        ? { text: 'PAGO PARCIAL', color: C.amber, sub: `Saldo ${COP(balance)}` }
        : { text: 'PENDIENTE', color: C.orange, sub: sale.due_date ? `Vence ${day(sale.due_date)}` : `Saldo ${COP(balance)}` };

  const docTypeLabel = DOC_TYPES[sale.customer_document_type || sale.customer?.document_type] || 'Doc.';
  const methodLabel = METHODS[sale.payment_method] || sale.payment_method;
  const paymentForm = sale.payment_form === 'credito'
    ? `Crédito${sale.credit_days ? ` ${sale.credit_days} días` : ''}`
    : sale.payment_form === 'contado' ? `Contado${methodLabel ? ` (${methodLabel})` : ''}` : methodLabel;
  const address = [sale.customer_address || sale.customer?.address, sale.customer_city_name].filter(Boolean).join(', ');

  const fields = [
    { k: 'Cliente', v: sale.customer_name || 'Consumidor final', bold: true },
    { k: docTypeLabel === 'NIT' ? 'NIT' : 'NIT / CC', v: sale.customer_tax_id ? `${docTypeLabel} ${sale.customer_tax_id}` : null },
    { k: 'Teléfono', v: sale.customer_phone || sale.customer?.phone },
    { k: 'Dirección', v: address },
    { k: 'Correo', v: sale.customer_email || sale.customer?.email },
    { k: 'Emisión', v: day(sale.sale_date || sale.created_at) },
    { k: 'Vencimiento', v: sale.due_date ? day(sale.due_date) : null },
    { k: 'Forma de pago', v: paymentForm },
    { k: 'Estado', v: status.text, color: status.color, sub: status.sub, bold: true },
    { k: 'Ref. taller', v: ctx.workOrder ? `Orden ${ctx.workOrder.order_number}` : null },
    { k: 'Cotización', v: sale.quote_number },
    { k: 'Remisión', v: isInvoice ? sale.remision_number : null },
    { k: 'Técnico', v: features.technician_field_enabled ? sale.technician_name : null },
  ].filter(f => f.v);

  const drawGrid = (cells, cols = 3) => {
    const colW = W / cols;
    for (let i = 0; i < cells.length; i += cols) {
      const row = cells.slice(i, i + cols);
      doc.font('Helvetica-Bold').fontSize(9.2);
      const heights = row.map(c => {
        doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.big ? 13 : 9.2);
        return 12 + doc.heightOfString(String(c.v), { width: colW - 18 }) + (c.sub ? 11 : 0);
      });
      const rowH = Math.max(...heights) + 10;
      ensure(rowH);
      row.forEach((c, j) => {
        const x = M + j * colW + (j === 0 ? 0 : 12);
        const w = colW - (j === 0 ? 12 : 18);
        if (j > 0) doc.moveTo(M + j * colW, y).lineTo(M + j * colW, y + rowH - 6).strokeColor(C.line).lineWidth(0.6).stroke();
        label(c.k, x, y);
        doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.big ? 13 : 9.2).fillColor(c.color || C.ink)
          .text(String(c.v), x, y + 11, { width: w });
        if (c.sub) doc.font('Helvetica').fontSize(7.6).fillColor(C.muted).text(c.sub, x, doc.y + 1, { width: w });
      });
      y += rowH;
      if (i + cols < cells.length) { hr(y - 4, M, M + W, C.soft); y += 4; }
    }
  };

  section(isInvoice ? 'Datos del cliente y facturación' : 'Datos del cliente y entrega');
  drawGrid(fields);
  y += 8;

  /* ═══ 2. FICHA TÉCNICA DEL VEHÍCULO ══════════════════════════════ */
  // Vehículo atendido (taller / campo de vehículo en ventas).
  const sv = ctx.serviceVehicle;
  const vehicleFieldOn = features.vehicle_field_enabled !== false;
  if ((ctx.workshopEnabled || vehicleFieldOn) && (sale.vehicle_plate || sale.vehicle_brand)) {
    const vFields = [
      { k: 'Placa', v: sale.vehicle_plate, bold: true, big: true },
      { k: 'Marca / Línea', v: [sale.vehicle_brand || sv?.brand, sale.vehicle_model || sv?.model].filter(Boolean).join(' ') || null },
      { k: 'Modelo (año)', v: sale.vehicle_year || sv?.year },
      { k: 'Color', v: sale.vehicle_color || sv?.color },
      { k: 'N° VIN / Chasis', v: sv?.vin },
      { k: 'N° Motor', v: sv?.engine_number },
      { k: 'Kilometraje', v: sale.mileage ? `${Number(sale.mileage).toLocaleString('es-CO')} km` : null },
    ].filter(f => f.v);
    section('Ficha técnica del vehículo');
    drawGrid(vFields, vFields.length >= 4 ? 4 : vFields.length);
    y += 8;
  }

  // Vehículo vendido (producto tipo vehículo): soporte para tránsito.
  const items = (ctx.items || []).filter(i => i.approval_status !== 'rechazado');
  const soldVehicles = items.filter(i => i.product?.product_type === 'vehicle' && i.product?.vehicle);
  for (const item of soldVehicles) {
    const v = item.product.vehicle;
    const vFields = [
      { k: 'Marca', v: v.brand }, { k: 'Línea', v: v.model }, { k: 'Modelo', v: v.year }, { k: 'Color', v: v.color },
      { k: 'N° VIN / Chasis', v: v.vin }, { k: 'N° Motor', v: v.engine_number }, { k: 'Cilindraje', v: v.engine }, { k: 'Placa', v: v.plate },
    ].filter(f => f.v);
    if (!vFields.length) continue;
    section(`Vehículo vendido — ${item.product?.name || item.product_name}`);
    drawGrid(vFields, 4);
    y += 8;
  }

  /* ═══ 3. DETALLE ═════════════════════════════════════════════════ */
  const showTaxCol = !hideTax;
  const COL = showTaxCol
    ? { num: [M, 26], code: [M + 26, 74], desc: [M + 100, 188], qty: [M + 288, 38], price: [M + 326, 66], tax: [M + 392, 34], total: [M + 426, W - 426] }
    : { num: [M, 26], code: [M + 26, 74], desc: [M + 100, 222], qty: [M + 322, 38], price: [M + 360, 66], total: [M + 426, W - 426] };
  const drawHead = () => {
    doc.rect(M, y, W, 24).fill(C.soft);
    hr(y + 24);
    const hy = y + 8.5;
    label('#', COL.num[0] + 8, hy);
    label('Código / Ref', COL.code[0] + 4, hy, { width: COL.code[1] });
    label('Descripción', COL.desc[0] + 4, hy);
    label('Cant.', COL.qty[0], hy, { width: COL.qty[1], align: 'center' });
    label(hideTax ? 'Vr. unit. c/imp.' : 'Vr. unitario', COL.price[0], hy, { width: COL.price[1] - 4, align: 'right' });
    if (showTaxCol) label('Imp.', COL.tax[0], hy, { width: COL.tax[1], align: 'center' });
    label('Total', COL.total[0], hy, { width: COL.total[1] - 8, align: 'right' });
    y += 30;
  };

  section(isInvoice ? 'Detalle de la venta' : 'Detalle', 60);
  drawHead();

  const rows = [];
  for (const entry of groupComboLines(items)) {
    if (entry.type === 'line') rows.push({ item: entry.item });
    else if (!entry.showBreakdown) collapseComboLinesForDian(entry.items).forEach(item => rows.push({ item }));
    else {
      rows.push({ combo: entry });
      entry.items.forEach(item => rows.push({ item, component: true }));
    }
  }

  let lineNo = 0;
  for (const { item, combo, component } of rows) {
    if (combo) {
      if (ensure(22)) drawHead();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
        .text(`Combo: ${combo.name}${combo.quantity !== 1 ? ` × ${combo.quantity}` : ''}`, COL.desc[0] + 4, y + 4, { width: COL.desc[1] + 60 })
        .text(COP(combo.total), COL.total[0], y + 4, { width: COL.total[1] - 8, align: 'right' });
      y += 20;
      hr(y - 2);
      continue;
    }
    const qty = n(item.quantity) || 1;
    const unit = hideTax ? n(item.total) / qty : n(item.unit_price);
    const name = item.product?.name || item.product_name || item.description || '';
    const tag = ITEM_TAGS[item.item_type] || (item.product?.product_type === 'service' ? 'Servicio' : 'Producto');
    const descX = COL.desc[0] + 4 + (component ? 10 : 0);
    const descW = COL.desc[1] - 8 - (component ? 10 : 0);
    const disc = n(item.discount_percentage);
    const sub = [tag, disc ? `Desc. ${disc}%` : null].filter(Boolean).join('  ·  ');
    doc.font('Helvetica-Bold').fontSize(9.2);
    const nameH = doc.heightOfString(name, { width: descW });
    const rowH = Math.max(30, nameH + 22);
    if (ensure(rowH)) drawHead();

    lineNo += 1;
    const ty = y + 6;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brand)
      .text(String(lineNo).padStart(2, '0'), COL.num[0] + 6, ty, { width: COL.num[1] - 6 });
    doc.font('Helvetica').fontSize(7.8).fillColor(C.slate)
      .text(item.product_sku || item.product?.sku || '—', COL.code[0] + 4, ty + 1, { width: COL.code[1] - 6, height: 20, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(9.2).fillColor(C.ink).text(`${component ? '– ' : ''}${name}`, descX, ty, { width: descW });
    doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(sub, descX, ty + nameH + 2, { width: descW });
    doc.font('Helvetica').fontSize(9).fillColor(C.slate)
      .text(String(qty), COL.qty[0], ty, { width: COL.qty[1], align: 'center' })
      .text(COP(unit), COL.price[0], ty, { width: COL.price[1] - 4, align: 'right' });
    if (showTaxCol) {
      // IVA de la línea ("Excl." si no causa IVA, "Exento" si es 0 %) y,
      // debajo, el impoconsumo si el producto lo tiene.
      const tp = n(item.tax_percentage);
      const inc = n(item.inc_rate);
      const ivaLabel = tp ? `${tp}%` : (item.iva_status === 'excluido' ? 'Excl.' : 'Exento');
      doc.font('Helvetica').fontSize(tp ? 9 : 7.4).fillColor(C.slate).text(ivaLabel, COL.tax[0] - 4, ty, { width: COL.tax[1] + 8, align: 'center' });
      if (inc) doc.font('Helvetica').fontSize(6.6).fillColor(C.muted).text(`INC ${inc}%`, COL.tax[0] - 4, ty + 11, { width: COL.tax[1] + 8, align: 'center' });
    }
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(COP(item.total), COL.total[0], ty, { width: COL.total[1] - 8, align: 'right' });
    y += rowH;
    hr(y);
  }
  y += 16;

  /* ═══ 4. MONTO EN LETRAS + NOTAS (izq) · TOTALES (der) ═══════════ */
  // Impuestos desde las líneas (misma fuente que el total); AIU conserva su
  // desglose porque el IVA va solo sobre la utilidad.
  const taxes = sale.aiu_enabled
    ? (sale.tax_breakdown || []).filter(t => t.type === 'tax')
    : taxLinesFromItems(items);
  // Subtotal antes de los descuentos de línea: el subtotal guardado ya es la
  // base neta, y mostrarlo seguido de "Descuentos" restaba el descuento dos
  // veces a la vista (Subtotal − Descuentos + impuestos ≠ Total).
  const lineDiscounts = items.reduce((s, i) => s + n(i.discount_amount), 0);
  const netBase = items.reduce((s, i) => s + n(i.total) - n(i.tax_amount) - n(i.inc_amount), 0);
  const retentions = [
    ['ReteFuente', n(sale.retefuente_rate), n(sale.retefuente_amount), '%'],
    ['ReteIVA', n(sale.reteiva_rate), n(sale.reteiva_amount), '%'],
    ['ReteICA', n(sale.reteica_rate), n(sale.reteica_amount), '‰'],
  ].filter(r => r[2] > 0);
  const totalRetentions = n(sale.total_retentions) || retentions.reduce((s, r) => s + r[2], 0);
  const payable = n(sale.total_amount) - totalRetentions;

  const totals = [];
  if (!hideTax) {
    if (sale.aiu_enabled) {
      totals.push(['Costo directo', COP(sale.aiu_direct_amount)]);
      totals.push([`Administración ${n(sale.aiu_admin_pct)}%`, COP(sale.aiu_admin_amount)]);
      totals.push([`Imprevistos ${n(sale.aiu_unforeseen_pct)}%`, COP(sale.aiu_unforeseen_amount)]);
      totals.push([`Utilidad ${n(sale.aiu_profit_pct)}%`, COP(sale.aiu_profit_amount)]);
    }
    if (sale.aiu_enabled) totals.push(['Subtotal', COP(sale.subtotal)]);
    else {
      totals.push(['Subtotal', COP(netBase + lineDiscounts)]);
      if (lineDiscounts > 0) totals.push(['Descuentos', `- ${COP(lineDiscounts)}`]);
    }
    if (taxes.length) {
      taxes.forEach(t => {
        const taxName = t.code === '04' ? 'INC (impoconsumo)' : t.name;
        if (t.taxable) totals.push([`Base ${t.code === '04' ? 'INC' : 'gravable'} (${n(t.rate)}%)`, COP(t.taxable), true]);
        totals.push([sale.aiu_enabled && t.code === '01' ? 'IVA s/ utilidad' : `${taxName} ${n(t.rate)}%`, COP(t.amount)]);
      });
    }
  } else if (lineDiscounts > 0) {
    totals.push(['Descuentos', `- ${COP(lineDiscounts)}`]);
  }
  if (n(sale.global_discount_amount) > 0) totals.push(['Descuento global', `- ${COP(sale.global_discount_amount)}`]);

  const TX = M + W - 262;
  const TW = 262;
  const LW = TX - M - 24;

  // Bloque izquierdo
  const notes = [
    pdfConfig.warranty_note?.trim() ? ['Garantía', pdfConfig.warranty_note.trim()] : null,
    pdfConfig.payment_notes?.trim() ? ['Observaciones de pago', pdfConfig.payment_notes.trim()] : null,
    // Letra de cambio (Art. 772 C. Co.) es un efecto de la factura, no de la remisión.
    isInvoice && pdfConfig.legal_note?.trim() ? ['Efectos legales', pdfConfig.legal_note.trim()] : null,
    ctx.icaActivity?.ciiu_code ? ['Actividad económica', `CIIU ${ctx.icaActivity.ciiu_code}${ctx.icaActivity.description ? ` (${ctx.icaActivity.description})` : ''}`] : null,
  ].filter(Boolean);

  // Pagos: hasta 4 van compactos en esta columna, junto a los totales (antes
  // eran una tabla a todo el ancho debajo de los totales y solían caer solos
  // en la página 2). Con más pagos se usa la tabla completa, más abajo.
  const payments = sale.payment_history || [];
  const compactPayments = payments.length > 0 && payments.length <= 4;
  // Referencias que pone el sistema solo: no aportan nada en el documento.
  const AUTO_REFS = /^(pago registrado al confirmar la venta|pago recibido)\.?$/i;
  const payRef = (p) => {
    const r = String(p.notes || p.reference || '').trim();
    return r && !AUTO_REFS.test(r) ? r : '';
  };
  const PC = { date: 50, method: 78 }; // columnas del bloque compacto (valor: el resto, a la derecha)
  const compactPaymentsH = () => {
    if (!compactPayments) return 0;
    let h = 12;
    payments.forEach(p => {
      h += 14;
      const r = payRef(p);
      if (r) { doc.font('Helvetica').fontSize(6.8); h += doc.heightOfString(r, { width: LW }) + 1; }
    });
    return h + 10;
  };

  const measureLeft = () => {
    doc.font('Helvetica-Bold').fontSize(9);
    let h = 12 + doc.heightOfString(amountInWords(payable), { width: LW }) + 12;
    h += compactPaymentsH();
    notes.forEach(([, text]) => { doc.font('Helvetica').fontSize(7.6); h += 10 + doc.heightOfString(text, { width: LW }) + 6; });
    return h;
  };
  const rightH = totals.length * 17 + 52 + (retentions.length ? retentions.length * 17 + 24 : 0) + (n(sale.paid_amount) > 0 ? 22 : 0) + (balance > 0.5 && n(sale.paid_amount) > 0 ? 18 : 0);
  ensure(Math.min(Math.max(measureLeft(), rightH), BOTTOM - 54));
  const blockTop = y;

  let ly = blockTop;
  label('Monto en letras', M, ly);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink).text(amountInWords(payable), M, ly + 11, { width: LW });
  ly = doc.y + 12;
  if (compactPayments) {
    label(payments.length > 1 ? 'Pagos' : 'Pago', M, ly);
    ly += 12;
    for (const p of payments) {
      hr(ly - 2, M, M + LW, C.soft);
      doc.font('Helvetica').fontSize(7.8).fillColor(C.muted).text(day(p.date), M, ly + 1, { width: PC.date, lineBreak: false });
      doc.font('Helvetica').fontSize(7.8).fillColor(C.slate)
        .text(METHODS[p.method] || p.method || 'Efectivo', M + PC.date, ly + 1, { width: PC.method, height: 10, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(8.2).fillColor(C.ink)
        .text(COP(p.amount), M + PC.date + PC.method, ly + 0.5, { width: LW - PC.date - PC.method, align: 'right', lineBreak: false });
      ly += 14;
      const r = payRef(p);
      if (r) {
        doc.font('Helvetica').fontSize(6.8).fillColor(C.muted).text(r, M + PC.date, ly - 2, { width: LW - PC.date });
        ly = doc.y + 1;
      }
    }
    ly += 10;
  }
  for (const [title2, text] of notes) {
    label(title2, M, ly);
    doc.font('Helvetica').fontSize(7.6).fillColor(C.slate).text(text, M, ly + 10, { width: LW });
    ly = doc.y + 8;
  }

  // Bloque derecho
  let ry = blockTop;
  for (const [k, v, sub] of totals) {
    doc.font('Helvetica').fontSize(sub ? 7.6 : 8.4).fillColor(sub ? C.muted : C.slate).text(k, TX, ry, { width: TW - 110 });
    doc.font(sub ? 'Helvetica' : 'Helvetica-Bold').fontSize(sub ? 7.6 : 8.6).fillColor(sub ? C.muted : C.ink).text(v, TX + TW - 120, ry, { width: 120, align: 'right' });
    ry += 17;
  }
  ry += 4;
  hr(ry, TX, TX + TW, brand, 1.4);
  ry += 12;
  label(retentions.length ? 'Total' : 'Total a pagar', TX, ry + 6);
  doc.font('Helvetica-Bold').fontSize(19).fillColor(C.ink).text(COP(sale.total_amount), TX + 60, ry, { width: TW - 60, align: 'right' });
  ry += 30;
  if (retentions.length) {
    retentions.forEach(([k, rate, amount, unit]) => {
      doc.font('Helvetica').fontSize(8.4).fillColor(C.slate).text(`${k} (${rate}${unit})`, TX, ry, { width: TW - 110 });
      doc.font('Helvetica-Bold').fontSize(8.6).fillColor(C.orange).text(`- ${COP(amount)}`, TX + TW - 120, ry, { width: 120, align: 'right' });
      ry += 17;
    });
    label('Neto a pagar', TX, ry + 3);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text(COP(payable), TX + 60, ry, { width: TW - 60, align: 'right' });
    ry += 24;
  }
  if (n(sale.paid_amount) > 0) {
    hr(ry - 4, TX, TX + TW);
    label('Pagado', TX, ry + 4);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.paid).text(COP(sale.paid_amount), TX + 60, ry + 2, { width: TW - 60, align: 'right' });
    ry += 22;
    if (balance > 0.5) {
      label('Saldo pendiente', TX, ry + 2);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.orange).text(COP(balance), TX + 60, ry, { width: TW - 60, align: 'right' });
      ry += 18;
    }
  }
  hr(ry, TX, TX + TW);
  y = Math.max(ly, ry) + 20;

  /* ═══ 5. PAGOS (más de 4: tabla compacta a todo el ancho) ════════ */
  if (payments.length && !compactPayments) {
    section('Pagos', 20 + 18); // encabezado + primera fila juntos
    const P = { date: [M, 80], method: [M + 80, 100], value: [M + 180, 90], ref: [M + 284, W - 284] };
    const head = () => {
      doc.rect(M, y, W, 18).fill(C.soft);
      hr(y + 18);
      label('Fecha', P.date[0] + 8, y + 6);
      label('Medio', P.method[0], y + 6);
      label('Valor', P.value[0], y + 6, { width: P.value[1], align: 'right' });
      label('Referencia', P.ref[0], y + 6);
      y += 21;
    };
    head();
    for (const p of payments) {
      doc.font('Helvetica').fontSize(7.4);
      const refText = payRef(p) || '—';
      const h = Math.max(16, doc.heightOfString(refText, { width: P.ref[1] - 6 }) + 7);
      if (ensure(h)) head();
      doc.font('Helvetica').fontSize(7.8).fillColor(C.muted).text(day(p.date), P.date[0] + 8, y + 2);
      doc.font('Helvetica').fontSize(8.2).fillColor(C.slate).text(METHODS[p.method] || p.method || 'Efectivo', P.method[0], y + 2, { width: P.method[1] - 6 });
      doc.font('Helvetica-Bold').fontSize(8.2).fillColor(C.ink).text(COP(p.amount), P.value[0], y + 2, { width: P.value[1], align: 'right' });
      doc.font('Helvetica').fontSize(7.4).fillColor(C.muted).text(refText, P.ref[0], y + 2.5, { width: P.ref[1] - 6 });
      y += h;
      hr(y - 2, M, M + W, C.soft);
    }
    y += 12;
  }

  /* ═══ 6. NOTA ════════════════════════════════════════════════════ */
  const noteLines = [
    sale.notes?.trim(),
    ctx.workOrder && !String(sale.notes || '').includes(ctx.workOrder.order_number) ? `Generada desde la orden de trabajo ${ctx.workOrder.order_number}.` : null,
    isInvoice && sale.remision_number ? `Factura de la remisión ${sale.remision_number}.` : null,
  ].filter(Boolean).join('\n');
  if (noteLines) {
    doc.font('Helvetica').fontSize(8.8);
    section('Nota', doc.heightOfString(noteLines, { width: W - 10 }));
    doc.font('Helvetica').fontSize(8.8).fillColor(C.slate).text(noteLines, M + 4, y, { width: W - 10 });
    y = doc.y + 18;
  }

  /* ═══ 7. DIAGRAMA DE INTERVENCIÓN (si lo hay) ════════════════════ */
  if ((sale.diagnosis_marks || []).length) {
    y = await drawDiagnosisSection(doc, sale, y, { MARGIN: M, INNER_W: W, gray: C.muted, black: C.ink, border: C.line });
    y += 10;
  }

  /* ═══ 8. VALIDACIÓN FISCAL (factura) ═════════════════════════════ */
  if (isInvoice) {
    const accepted = sale.dian_status === 'accepted' && sale.cufe;
    section('Validación fiscal', accepted ? 112 : 46);
    if (accepted) {
      const QR = 104;
      try {
        const qr = await QRCode.toDataURL(buildDianQrContent(sale, tenant), { margin: 0, width: QR * 4 });
        doc.image(Buffer.from(qr.split(',')[1], 'base64'), M, y, { fit: [QR, QR] });
      } catch {
        doc.font('Helvetica-Oblique').fontSize(7).fillColor(C.muted).text('(No se pudo generar el QR)', M, y + 40, { width: QR });
      }
      const BX = M + QR + 20;
      const BW = W - QR - 20;
      doc.rect(BX, y, BW, QR).fillAndStroke(C.soft, C.line);
      doc.rect(BX, y, 3, QR).fill(brand);
      label('Documento validado por la DIAN', BX + 18, y + 14);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(C.ink).text('FACTURA ELECTRÓNICA DE VENTA', BX + 18, y + 28, { width: BW - 36 });
      doc.font('Helvetica').fontSize(8.2).fillColor(C.muted)
        .text(`Fecha de validación · ${day(sale.dian_accepted_at || sale.sale_date)}`, BX + 18, y + 47, { width: BW - 36 });
      label('CUFE', BX + 18, y + 63);
      doc.font('Helvetica').fontSize(6.6).fillColor(C.muted).text(sale.cufe, BX + 18, y + 74, { width: BW - 36 });
      y += QR + 10;
    } else {
      doc.rect(M, y, W, 36).fillAndStroke(C.soft, C.line);
      const pending = { pending: 'Pendiente de envío a la DIAN', sending: 'En validación por la DIAN', rejected: 'Rechazada por la DIAN', error: 'Error en el envío a la DIAN' }[sale.dian_status] || 'Sin validación DIAN';
      doc.font('Helvetica-Bold').fontSize(8.6).fillColor(sale.dian_status === 'rejected' || sale.dian_status === 'error' ? C.red : C.amber)
        .text(pending, M + 16, y + 9, { width: W - 32 });
      doc.font('Helvetica').fontSize(7.4).fillColor(C.muted)
        .text('Esta representación gráfica no tiene validez fiscal hasta que la DIAN valide el documento (CUFE).', M + 16, y + 21, { width: W - 32 });
      y += 46;
    }
  }

  /* ═══ PIE DE PÁGINA ══════════════════════════════════════════════ */
  const range = doc.bufferedPageRange();
  const footer = isInvoice
    ? `${tenant.company_name || ''}  ·  Representación gráfica de factura electrónica de venta`
    : `${tenant.company_name || ''}  ·  Documento generado digitalmente`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // pie dentro del margen: sin esto pdfkit agrega páginas en blanco
    doc.rect(0, 0, PAGE_W, 4).fill(brand);
    hr(PAGE_H - 38, M - 3, M + W + 3);
    if (isInvoice && sale.cufe && i === range.count - 1 && range.count > 1) {
      doc.font('Helvetica').fontSize(5.8).fillColor(C.muted).text(`CUFE: ${sale.cufe}`, M, PAGE_H - 50, { width: W, lineBreak: false });
    }
    doc.font('Helvetica').fontSize(7.2).fillColor(C.muted)
      .text(footer, M - 3, PAGE_H - 30, { width: W - 60, lineBreak: false })
      .text(String(i + 1).padStart(2, '0'), M + W - 57, PAGE_H - 30, { width: 60, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}

module.exports = { generatePremiumSalePDFBuffer };
