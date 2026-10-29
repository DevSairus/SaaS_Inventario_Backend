// backend/src/services/pos/posTicket.service.js
//
// Tirillas para impresora POS (58/80 mm): factura y remisión, recibo de pago
// (ventas y órdenes de trabajo) y cierre de caja.
//
// El backend no arma HTML ni comandos de impresora: devuelve la tirilla como
// una lista de bloques neutros que no dependen del ancho del papel. El
// navegador los convierte a HTML (frontend/src/utils/posPrinting.js) y un
// agente local de impresión podrá convertirlos a ESC/POS con los mismos datos.
//
// Bloques:
//   { t: 'logo', url }
//   { t: 'text', text, align: 'left'|'center'|'right', bold, size: 'sm'|'md'|'lg'|'xl' }
//   { t: 'kv', k, v, bold, size }            etiqueta a la izquierda, valor a la derecha
//   { t: 'item', name, detail, total }       línea de producto (detalle = cant × unitario, impuesto)
//   { t: 'sep' }                             línea divisoria
//   { t: 'qr', data, image }                 contenido del QR y su imagen (data URL)
//   { t: 'sign', labels: [..] }              líneas para firmar
const QRCode = require('qrcode');
const { groupComboLines, collapseComboLinesForDian } = require('../../utils/comboLines');
const { amountInWords } = require('../../utils/numberToWords');
const { saleBalance } = require('../../utils/saleAmounts');
const { taxLinesFromItems } = require('../taxService');
const { loadContext, buildDianQrContent, DOC_TYPES, METHODS } = require('../sales/salePremiumPdfService');

const n = (v) => Number(v) || 0;
const COP = (v) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n(v));
const qty = (v) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(n(v));
const TZ = 'America/Bogota';
// Fechas de solo día ('YYYY-MM-DD') al mediodía para no correr un día por zona horaria.
const day = (v) => {
  if (!v) return '';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return d.toLocaleDateString('es-CO', { timeZone: TZ });
};
const time = (v) => (v ? new Date(v).toLocaleTimeString('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '');
const dateTime = (v) => (v ? `${day(v)} ${time(v)}` : '');
const methodLabel = (m) => METHODS[String(m || '').toLowerCase()] || METHODS[m] || m || 'Efectivo';
const userName = (u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : '');
const customerName = (c) => (c ? (c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ')) : '');

const text = (value, opts = {}) => ({ t: 'text', text: String(value), align: 'left', ...opts });
const center = (value, opts = {}) => text(value, { align: 'center', ...opts });
const kv = (k, v, opts = {}) => ({ t: 'kv', k, v: String(v), ...opts });
const SEP = { t: 'sep' };

// Encabezado común: logo, razón social, nombre comercial, NIT, dirección y teléfono.
function headerBlocks(tenant, { branch } = {}) {
  const blocks = [];
  if (tenant.logo_url && String(tenant.logo_url).startsWith('http')) blocks.push({ t: 'logo', url: tenant.logo_url });
  const legalName = String(tenant.business_name || '').trim() || tenant.company_name || 'Empresa';
  const tradeName = String(tenant.company_name || '').trim();
  blocks.push(center(legalName, { bold: true, size: 'lg' }));
  if (tradeName && tradeName.toUpperCase() !== legalName.toUpperCase()) blocks.push(center(tradeName.toUpperCase(), { bold: true }));
  const levelCode = tenant.dian_config?.tax_level_code;
  const ivaRegime = levelCode ? (levelCode === 'R-99-PN' ? 'No responsable de IVA' : 'Responsable de IVA') : null;
  const nit = tenant.tax_id ? `NIT ${tenant.tax_id}${tenant.dian_config?.dv && !String(tenant.tax_id).includes('-') ? `-${tenant.dian_config.dv}` : ''}` : null;
  [nit, ivaRegime, branch?.address || tenant.address, tenant.phone ? `Tel. ${tenant.phone}` : null]
    .filter(Boolean)
    .forEach((line) => blocks.push(center(line, { size: 'sm' })));
  if (branch?.name) blocks.push(center(`Sede ${branch.name}`, { size: 'sm' }));
  return blocks;
}

async function qrBlock(data) {
  try {
    const image = await QRCode.toDataURL(data, { margin: 0, width: 320, errorCorrectionLevel: 'M' });
    return { t: 'qr', data, image };
  } catch {
    return null;
  }
}

// ── Factura / remisión ────────────────────────────────────────────────────────
async function buildSaleTicket(sale, tenant) {
  const ctx = await loadContext(sale, tenant);
  const features = tenant.features || {};
  const pdfConfig = tenant.pdf_config || {};
  const isInvoice = sale.document_type === 'factura';
  const hideTax = isInvoice ? !!features.hide_invoice_tax : features.hide_remision_tax !== false;
  const number = sale.dian_invoice_number || sale.sale_number || '';
  const blocks = headerBlocks(tenant);

  blocks.push(SEP);
  blocks.push(center(isInvoice ? 'FACTURA ELECTRÓNICA DE VENTA' : 'REMISIÓN', { bold: true, size: 'md' }));
  blocks.push(center(number, { bold: true, size: 'lg' }));
  blocks.push(center(dateTime(sale.created_at || sale.sale_date), { size: 'sm' }));
  if (isInvoice && ctx.resolution) {
    const r = ctx.resolution;
    blocks.push(center(`Res. DIAN ${r.resolution_number}${r.resolution_date ? ` del ${day(r.resolution_date)}` : ''}`, { size: 'sm' }));
    blocks.push(center(`Rango ${r.prefix || ''}${r.from_number} a ${r.prefix || ''}${r.to_number}`, { size: 'sm' }));
    if (r.valid_to) blocks.push(center(`Vigente hasta ${day(r.valid_to)}`, { size: 'sm' }));
  }
  if (sale.status === 'cancelled') blocks.push(center('*** ANULADA ***', { bold: true, size: 'lg' }));

  // Cliente
  blocks.push(SEP);
  const docType = DOC_TYPES[sale.customer_document_type || sale.customer?.document_type] || 'Doc.';
  blocks.push(text(sale.customer_name || customerName(sale.customer) || 'Consumidor final', { bold: true }));
  if (sale.customer_tax_id) blocks.push(text(`${docType} ${sale.customer_tax_id}`, { size: 'sm' }));
  const phone = sale.customer_phone || sale.customer?.phone || sale.customer?.mobile;
  if (phone) blocks.push(text(`Tel. ${phone}`, { size: 'sm' }));
  const address = [sale.customer_address || sale.customer?.address, sale.customer_city_name].filter(Boolean).join(', ');
  if (address) blocks.push(text(address, { size: 'sm' }));
  if (sale.vehicle_plate) {
    const vehicle = [sale.vehicle_plate, [sale.vehicle_brand, sale.vehicle_model].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    blocks.push(text(`Vehículo: ${vehicle}${sale.mileage ? ` · ${Number(sale.mileage).toLocaleString('es-CO')} km` : ''}`, { size: 'sm' }));
  }
  if (ctx.workOrder) blocks.push(text(`Orden de trabajo ${ctx.workOrder.order_number}`, { size: 'sm' }));
  if (isInvoice && sale.remision_number) blocks.push(text(`Remisión ${sale.remision_number}`, { size: 'sm' }));
  if (features.technician_field_enabled && sale.technician_name) blocks.push(text(`Técnico: ${sale.technician_name}`, { size: 'sm' }));

  // Detalle
  blocks.push(SEP);
  const items = (ctx.items || []).filter((i) => i.approval_status !== 'rechazado');
  const pushItem = (item, prefix = '') => {
    const q = n(item.quantity) || 1;
    const unit = hideTax ? n(item.total) / q : n(item.unit_price);
    const tp = n(item.tax_percentage);
    const taxTag = hideTax ? null : tp ? `IVA ${tp}%` : (item.iva_status === 'excluido' ? 'Excluido' : 'Exento');
    const disc = n(item.discount_percentage);
    blocks.push({
      t: 'item',
      name: `${prefix}${item.product?.name || item.product_name || item.description || ''}`,
      detail: [`${qty(q)} x ${COP(unit)}`, disc ? `Desc. ${disc}%` : null, taxTag, n(item.inc_rate) ? `INC ${n(item.inc_rate)}%` : null].filter(Boolean).join('  '),
      total: COP(item.total),
    });
  };
  for (const entry of groupComboLines(items)) {
    if (entry.type === 'line') pushItem(entry.item);
    else if (!entry.showBreakdown) collapseComboLinesForDian(entry.items).forEach((item) => pushItem(item));
    else {
      blocks.push(kv(`Combo: ${entry.name}${entry.quantity !== 1 ? ` x ${entry.quantity}` : ''}`, COP(entry.total), { bold: true }));
      entry.items.forEach((item) => pushItem(item, '- '));
    }
  }
  blocks.push(text(`${items.length} ítem${items.length !== 1 ? 's' : ''}`, { size: 'sm' }));

  // Totales (mismo cálculo que el PDF)
  blocks.push(SEP);
  const taxes = sale.aiu_enabled ? (sale.tax_breakdown || []).filter((t) => t.type === 'tax') : taxLinesFromItems(items);
  const lineDiscounts = items.reduce((s, i) => s + n(i.discount_amount), 0);
  const netBase = items.reduce((s, i) => s + n(i.total) - n(i.tax_amount) - n(i.inc_amount), 0);
  if (!hideTax) {
    if (sale.aiu_enabled) {
      blocks.push(kv('Costo directo', COP(sale.aiu_direct_amount)));
      blocks.push(kv(`Administración ${n(sale.aiu_admin_pct)}%`, COP(sale.aiu_admin_amount)));
      blocks.push(kv(`Imprevistos ${n(sale.aiu_unforeseen_pct)}%`, COP(sale.aiu_unforeseen_amount)));
      blocks.push(kv(`Utilidad ${n(sale.aiu_profit_pct)}%`, COP(sale.aiu_profit_amount)));
      blocks.push(kv('Subtotal', COP(sale.subtotal)));
    } else {
      blocks.push(kv('Subtotal', COP(netBase + lineDiscounts)));
      if (lineDiscounts > 0) blocks.push(kv('Descuentos', `-${COP(lineDiscounts)}`));
    }
    taxes.forEach((t) => {
      const taxName = t.code === '04' ? 'INC' : t.name;
      if (t.taxable) blocks.push(kv(`Base ${taxName} ${n(t.rate)}%`, COP(t.taxable), { size: 'sm' }));
      blocks.push(kv(sale.aiu_enabled && t.code === '01' ? 'IVA s/ utilidad' : `${taxName} ${n(t.rate)}%`, COP(t.amount)));
    });
  } else if (lineDiscounts > 0) {
    blocks.push(kv('Descuentos', `-${COP(lineDiscounts)}`));
  }
  if (n(sale.global_discount_amount) > 0) blocks.push(kv('Descuento global', `-${COP(sale.global_discount_amount)}`));
  blocks.push(kv('TOTAL', COP(sale.total_amount), { bold: true, size: 'lg' }));

  const retentions = [
    ['ReteFuente', n(sale.retefuente_rate), n(sale.retefuente_amount), '%'],
    ['ReteIVA', n(sale.reteiva_rate), n(sale.reteiva_amount), '%'],
    ['ReteICA', n(sale.reteica_rate), n(sale.reteica_amount), '‰'],
  ].filter((r) => r[2] > 0);
  const totalRetentions = n(sale.total_retentions) || retentions.reduce((s, r) => s + r[2], 0);
  if (retentions.length) {
    retentions.forEach(([k, rate, amount, unit]) => blocks.push(kv(`${k} ${rate}${unit}`, `-${COP(amount)}`)));
    blocks.push(kv('NETO A PAGAR', COP(n(sale.total_amount) - totalRetentions), { bold: true }));
  }

  // Pago
  blocks.push(SEP);
  const paymentForm = sale.payment_form === 'credito'
    ? `Crédito${sale.credit_days ? ` ${sale.credit_days} días` : ''}`
    : sale.payment_form === 'contado' ? 'Contado' : null;
  if (paymentForm) blocks.push(kv('Forma de pago', paymentForm));
  if (sale.due_date && sale.payment_form === 'credito') blocks.push(kv('Vence', day(sale.due_date)));
  const payments = sale.payment_history || [];
  payments.forEach((p) => blocks.push(kv(methodLabel(p.method), COP(p.amount), { size: 'sm' })));
  const balance = saleBalance(sale);
  if (n(sale.paid_amount) > 0) blocks.push(kv('Pagado', COP(sale.paid_amount), { bold: true }));
  if (balance > 0.5) blocks.push(kv('Saldo pendiente', COP(balance), { bold: true }));
  blocks.push(text(`Son: ${amountInWords(n(sale.total_amount) - totalRetentions)}`, { size: 'sm' }));

  // Notas
  const notes = [
    sale.notes?.trim(),
    pdfConfig.warranty_note?.trim() ? `Garantía: ${pdfConfig.warranty_note.trim()}` : null,
    pdfConfig.payment_notes?.trim(),
    isInvoice && pdfConfig.legal_note?.trim() ? pdfConfig.legal_note.trim() : null,
    ctx.icaActivity?.ciiu_code ? `Actividad económica CIIU ${ctx.icaActivity.ciiu_code}` : null,
  ].filter(Boolean);
  if (notes.length) {
    blocks.push(SEP);
    notes.forEach((note) => blocks.push(text(note, { size: 'sm' })));
  }

  // Validación DIAN
  const dianPending = isInvoice && !(sale.dian_status === 'accepted' && sale.cufe);
  if (isInvoice) {
    blocks.push(SEP);
    if (!dianPending) {
      const qr = await qrBlock(buildDianQrContent(sale, tenant));
      if (qr) blocks.push(qr);
      blocks.push(center('CUFE', { bold: true, size: 'sm' }));
      blocks.push(center(sale.cufe, { size: 'sm' }));
      blocks.push(center(`Validada por la DIAN el ${dateTime(sale.dian_accepted_at || sale.sale_date)}`, { size: 'sm' }));
      blocks.push(center('Representación gráfica de factura electrónica de venta', { size: 'sm' }));
    } else {
      const pending = { pending: 'Pendiente de envío a la DIAN', sending: 'En validación por la DIAN', rejected: 'Rechazada por la DIAN', error: 'Error en el envío a la DIAN' }[sale.dian_status] || 'Sin validación DIAN';
      blocks.push(center(pending, { bold: true }));
      blocks.push(center('Sin validez fiscal hasta que la DIAN valide el documento (CUFE).', { size: 'sm' }));
    }
  }

  blocks.push(SEP);
  blocks.push(center('¡Gracias por su compra!', { bold: true }));

  // El cajón se abre si entró efectivo en este documento (lo usa el agente local).
  const cashIn = payments.some((p) => ['efectivo', 'cash'].includes(String(p.method || '').toLowerCase()));
  return {
    kind: 'sale',
    document_type: sale.document_type,
    title: `${isInvoice ? 'Factura' : 'Remisión'} ${number}`,
    dian_pending: dianPending,
    open_drawer: cashIn,
    blocks,
  };
}

// ── Recibo de pago ────────────────────────────────────────────────────────────
async function buildReceiptTicket(receipt, tenant) {
  const models = require('../../models');
  const isSale = receipt.source_type === 'sale';
  const source = isSale
    ? await models.Sale.findOne({ where: { id: receipt.source_id, tenant_id: receipt.tenant_id }, include: [{ model: models.Customer, as: 'customer' }] })
    : await models.WorkOrder.findOne({ where: { id: receipt.source_id, tenant_id: receipt.tenant_id }, include: [{ model: models.Customer, as: 'customer' }, { model: models.Vehicle, as: 'vehicle' }] });
  const branch = receipt.branch_id ? await models.Branch.findByPk(receipt.branch_id, { attributes: ['name', 'address'] }) : null;

  const blocks = headerBlocks(tenant, { branch });
  blocks.push(SEP);
  blocks.push(center('RECIBO DE CAJA', { bold: true, size: 'md' }));
  blocks.push(center(receipt.receipt_number, { bold: true, size: 'lg' }));
  const payment = (source?.payment_history || []).find((p) => p.payment_id === receipt.payment_id);
  blocks.push(center(dateTime(payment?.created_at || payment?.date || receipt.created_at || receipt.payment_date), { size: 'sm' }));
  if (receipt.status === 'voided') {
    blocks.push(center('*** ANULADO ***', { bold: true, size: 'lg' }));
    if (receipt.voided_reason) blocks.push(center(receipt.voided_reason, { size: 'sm' }));
  }

  blocks.push(SEP);
  const name = receipt.customer_name || (isSale ? source?.customer_name : null) || customerName(source?.customer) || 'Cliente';
  blocks.push(kv('Recibimos de', ''));
  blocks.push(text(name, { bold: true }));
  const taxId = isSale ? source?.customer_tax_id : source?.customer?.tax_id;
  if (taxId) blocks.push(text(`Doc. ${taxId}`, { size: 'sm' }));
  const docLabel = isSale ? (source?.document_type === 'factura' ? 'Factura' : 'Remisión') : 'Orden de trabajo';
  const docNumber = isSale ? (source?.dian_invoice_number || source?.sale_number) : source?.order_number;
  blocks.push(kv('Concepto', `Pago ${docLabel} ${docNumber || receipt.reference || ''}`.trim()));
  if (!isSale && source?.vehicle?.plate) blocks.push(kv('Vehículo', source.vehicle.plate));

  blocks.push(SEP);
  blocks.push(kv('Medio de pago', methodLabel(receipt.method)));
  if (payment?.reference || payment?.notes) {
    const ref = String(payment.reference || payment.notes).trim();
    if (ref && !/^(pago registrado al confirmar la venta|pago recibido)\.?$/i.test(ref)) blocks.push(kv('Referencia', ref, { size: 'sm' }));
  }
  blocks.push(kv('VALOR', COP(receipt.amount), { bold: true, size: 'xl' }));
  blocks.push(text(`Son: ${amountInWords(n(receipt.amount))}`, { size: 'sm' }));

  if (source) {
    const total = isSale ? n(source.total_amount) : n(source.total_amount);
    const balance = isSale ? saleBalance(source) : Math.max(total - n(source.paid_amount), 0);
    blocks.push(SEP);
    blocks.push(kv(`Total ${docLabel.toLowerCase()}`, COP(total)));
    blocks.push(kv('Total abonado', COP(source.paid_amount)));
    blocks.push(kv('Saldo actual', COP(balance), { bold: true }));
  }

  blocks.push({ t: 'sign', labels: ['Recibido por'] });

  return {
    kind: 'receipt',
    title: `Recibo ${receipt.receipt_number}`,
    open_drawer: ['efectivo', 'cash'].includes(String(receipt.method || '').toLowerCase()),
    blocks,
  };
}

// ── Cierre de caja ────────────────────────────────────────────────────────────
const BUCKETS = [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia'], ['otro', 'Otros']];
const SOURCES = {
  sale: 'Ventas', work_order: 'Órdenes de trabajo', customer_advance: 'Anticipos de clientes',
  customer_advance_refund: 'Devolución de anticipos', opening_receivable: 'Saldos iniciales por cobrar',
  opening_payable: 'Saldos iniciales por pagar', customer_return_refund: 'Devoluciones a clientes',
  customer_return_reversal: 'Reversión de devoluciones', supplier_return_refund: 'Devoluciones de proveedores',
  purchase: 'Compras', expense: 'Gastos',
};

async function buildCashSessionTicket(session, tenant) {
  const { calculateExpected } = require('../../controllers/finance/cashSessions.controller');
  const isClosed = session.status === 'closed';
  const { expected: liveExpected, transactions } = await calculateExpected(session);
  const expected = isClosed ? (session.expected_amounts || {}) : liveExpected;

  const blocks = headerBlocks(tenant, { branch: session.branch });
  blocks.push(SEP);
  blocks.push(center(isClosed ? 'CIERRE DE CAJA' : 'ARQUEO DE CAJA', { bold: true, size: 'md' }));
  blocks.push(center(`Caja del ${day(session.session_date)}`, { bold: true }));
  if (!isClosed) blocks.push(center('Caja abierta: valores al momento de imprimir', { size: 'sm' }));
  blocks.push(SEP);
  blocks.push(kv('Abrió', `${userName(session.opener)} ${time(session.opened_at)}`.trim(), { size: 'sm' }));
  if (isClosed) blocks.push(kv('Cerró', `${userName(session.closer)} ${dateTime(session.closed_at)}`.trim(), { size: 'sm' }));
  else blocks.push(kv('Impreso', dateTime(new Date()), { size: 'sm' }));
  blocks.push(kv('Base de apertura', COP(session.opening_amount)));

  // Movimientos agrupados por origen
  const bySource = new Map();
  let totalIn = 0;
  let totalOut = 0;
  (transactions || []).forEach((t) => {
    const amount = n(t.amount);
    const key = `${t.direction}:${t.source}`;
    const row = bySource.get(key) || { direction: t.direction, source: t.source, count: 0, amount: 0 };
    row.count += 1;
    row.amount += amount;
    bySource.set(key, row);
    if (t.direction === 'in') totalIn += amount; else totalOut += amount;
  });
  blocks.push(SEP);
  blocks.push(text(`MOVIMIENTOS (${(transactions || []).length})`, { bold: true }));
  const rows = [...bySource.values()].sort((a, b) => (a.direction === b.direction ? b.amount - a.amount : a.direction === 'in' ? -1 : 1));
  rows.forEach((r) => blocks.push(kv(`${SOURCES[r.source] || r.source} (${r.count})`, `${r.direction === 'out' ? '-' : ''}${COP(r.amount)}`, { size: 'sm' })));
  blocks.push(kv('Total entradas', COP(totalIn), { bold: true }));
  if (totalOut > 0) blocks.push(kv('Total salidas', `-${COP(totalOut)}`, { bold: true }));

  // Cuadre por medio de pago
  blocks.push(SEP);
  blocks.push(text(isClosed ? 'CUADRE POR MEDIO DE PAGO' : 'ESPERADO POR MEDIO DE PAGO', { bold: true }));
  let totalExpected = 0;
  let totalCounted = 0;
  BUCKETS.forEach(([key, label]) => {
    const exp = n(expected[key]);
    if (!isClosed) {
      if (exp !== 0) blocks.push(kv(label, COP(exp)));
      totalExpected += exp;
      return;
    }
    const counted = n(session.counted_amounts?.[key]);
    const diff = n(session.differences?.[key]);
    if (exp === 0 && counted === 0) return;
    totalExpected += exp;
    totalCounted += counted;
    blocks.push(text(label, { bold: true, size: 'sm' }));
    blocks.push(kv('  Esperado', COP(exp), { size: 'sm' }));
    blocks.push(kv('  Contado', COP(counted), { size: 'sm' }));
    if (Math.abs(diff) >= 0.5) blocks.push(kv(diff > 0 ? '  Sobrante' : '  Faltante', COP(Math.abs(diff)), { size: 'sm', bold: true }));
  });
  blocks.push(kv('Total esperado', COP(totalExpected), { bold: true }));
  if (isClosed) {
    blocks.push(kv('Total contado', COP(totalCounted), { bold: true }));
    const totalDiff = Math.round((totalCounted - totalExpected) * 100) / 100;
    blocks.push(kv(Math.abs(totalDiff) < 0.5 ? 'Caja cuadrada' : totalDiff > 0 ? 'SOBRANTE' : 'FALTANTE',
      Math.abs(totalDiff) < 0.5 ? COP(0) : COP(Math.abs(totalDiff)), { bold: true, size: 'lg' }));
  }

  const notes = [session.opening_notes ? `Apertura: ${session.opening_notes}` : null, session.closing_notes ? `Cierre: ${session.closing_notes}` : null].filter(Boolean);
  if (notes.length) {
    blocks.push(SEP);
    notes.forEach((note) => blocks.push(text(note, { size: 'sm' })));
  }

  blocks.push({ t: 'sign', labels: ['Entregó', 'Recibió'] });

  return {
    kind: 'cash_session',
    title: `${isClosed ? 'Cierre' : 'Arqueo'} de caja ${day(session.session_date)}`,
    open_drawer: false,
    blocks,
  };
}

// Para quien imprime el recibo del pago recién registrado: el frontend conoce
// el payment_id de payment_history, no el id del recibo.
async function findReceiptByPayment(tenantId, paymentId) {
  const { Receipt } = require('../../models');
  return Receipt.findOne({ where: { tenant_id: tenantId, payment_id: paymentId } });
}

module.exports = { buildSaleTicket, buildReceiptTicket, buildCashSessionTicket, findReceiptByPayment };
