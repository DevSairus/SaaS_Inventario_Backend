// backend/src/services/workshopPdfService.js
const PDFDocument = require('pdfkit');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

/* ── helpers ─────────────────────────────────────────────── */
const COP = n =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

const fmtDate = d =>
  d ? new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

const fmtDateTime = d =>
  d ? new Date(d).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const downloadImage = url =>
  new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const chunks = [];
    proto.get(url, res => {
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

/* ── paleta compartida ────────────────────────────────────── */
const C = {
  primary:  '#1e40af',   // azul taller
  accent:   '#f97316',   // naranja
  dark:     '#111827',
  gray:     '#6b7280',
  lightGray:'#9ca3af',
  border:   '#e5e7eb',
  soft:     '#f8fafc',
  white:    '#ffffff',
  green:    '#059669',
  red:      '#dc2626',
  orange:   '#d97706',
};

/* ── dibujar cabecera empresa ─────────────────────────────── */
async function drawHeader(doc, tenant, title, subtitle, docNumber) {
  const MARGIN = 40;
  const PAGE_W = doc.page.width;
  const INNER  = PAGE_W - MARGIN * 2;

  // Banda superior
  doc.rect(0, 0, PAGE_W, 6).fill(C.primary);

  let y = 16;

  // Recuadro cabecera
  doc.roundedRect(MARGIN, y, INNER, 72, 5)
    .strokeColor(C.border).lineWidth(0.5).stroke();
  doc.rect(MARGIN, y, INNER, 72).fill(C.soft);

  // Logo
  let logoW = 0;
  if (tenant.logo_url) {
    try {
      let src = tenant.logo_url.startsWith('http')
        ? await downloadImage(tenant.logo_url)
        : (() => { const p = path.join(__dirname, '../../uploads/logos', tenant.logo_url); return fs.existsSync(p) ? p : null; })();
      if (src) {
        doc.image(src, MARGIN + 10, y + 8, { height: 52, fit: [80, 52] });
        logoW = 90;
      }
    } catch {}
  }

  // Info empresa
  const EX = MARGIN + logoW + 10;
  const EW = INNER * 0.55;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.dark)
    .text(tenant.company_name || 'Taller', EX, y + 10, { width: EW });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray);
  let ey = y + 24;
  [tenant.tax_id ? `NIT: ${tenant.tax_id}` : null, tenant.phone, tenant.address, tenant.email]
    .filter(Boolean).slice(0, 3)
    .forEach(l => { doc.text(l, EX, ey, { width: EW }); ey += 11; });

  // Tipo de doc (derecha)
  const DX = MARGIN + INNER - 155;
  doc.font('Helvetica-Bold').fontSize(15).fillColor(C.primary)
    .text(title, DX, y + 8, { width: 155, align: 'center' });
  if (subtitle) {
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray)
      .text(subtitle, DX, y + 28, { width: 155, align: 'center' });
  }
  if (docNumber) {
    doc.roundedRect(DX, y + 40, 155, 22, 4).fill(C.primary);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.white)
      .text(docNumber, DX, y + 46, { width: 155, align: 'center' });
  }

  return y + 72 + 10; // retorna posición Y siguiente
}

/* ── fila tabla ───────────────────────────────────────────── */
function tableRow(doc, cols, y, rowH = 18, bg = null) {
  if (bg) doc.rect(cols[0].x - 4, y, doc.page.width - 80 - cols[0].x + 4 + 4, rowH).fill(bg);
  cols.forEach(({ x, text, w, bold, align, color, size }) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(size || 8.5)
      .fillColor(color || C.dark)
      .text(String(text ?? ''), x, y + 3, { width: w || 80, align: align || 'left', ellipsis: true });
  });
}

/* ══════════════════════════════════════════════════════════════
   1. RECIBO DE PAGO
   ══════════════════════════════════════════════════════════════ */
const generatePaymentReceipt = async (res, order, tenant, paymentData) => {
  try {
    const doc = new PDFDocument({ size: 'A5', margin: 35, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${order.order_number}.pdf"`);
    doc.pipe(res);

    const MARGIN = 35;
    const PAGE_W = doc.page.width;   // ~420
    const INNER  = PAGE_W - MARGIN * 2;

    // Banda superior
    doc.rect(0, 0, PAGE_W, 5).fill(C.primary);

    let y = 14;

    // Título
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.primary)
      .text('RECIBO DE PAGO', MARGIN, y, { width: INNER, align: 'center' });
    y += 22;

    // Info empresa (compacto)
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.dark)
      .text(tenant.company_name || '', MARGIN, y, { width: INNER, align: 'center' });
    y += 13;
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray)
      .text([tenant.tax_id ? `NIT ${tenant.tax_id}` : null, tenant.phone].filter(Boolean).join('  ·  '), MARGIN, y, { width: INNER, align: 'center' });
    y += 18;

    // Número recibo + fecha
    const recNum = paymentData.receipt_number || `REC-${Date.now().toString().slice(-6)}`;
    doc.roundedRect(MARGIN, y, INNER, 28, 5).fill(C.primary);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.white)
      .text(recNum, MARGIN, y + 4, { width: INNER, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#bfdbfe')
      .text(fmtDateTime(paymentData.date || new Date()), MARGIN, y + 17, { width: INNER, align: 'center' });
    y += 38;

    // Datos cliente / OT
    const rows = [
      ['Orden de trabajo', order.order_number],
      ['Cliente', order.customer
        ? (order.customer.business_name || `${order.customer.first_name} ${order.customer.last_name}`)
        : 'Sin cliente'],
      ['Vehículo', order.vehicle
        ? `${order.vehicle.plate} · ${order.vehicle.brand || ''} ${order.vehicle.model || ''}`.trim()
        : '—'],
    ];

    doc.roundedRect(MARGIN, y, INNER, rows.length * 20 + 16, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    y += 10;
    rows.forEach(([label, value]) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(label, MARGIN + 10, y, { width: 90 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(value, MARGIN + 105, y, { width: INNER - 115 });
      y += 20;
    });
    y += 8;

    // Monto pagado (grande)
    doc.roundedRect(MARGIN, y, INNER, 50, 6).fill('#eff6ff');
    doc.font('Helvetica').fontSize(8).fillColor(C.gray)
      .text('VALOR RECIBIDO', MARGIN, y + 10, { width: INNER, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(22).fillColor(C.primary)
      .text(COP(paymentData.amount), MARGIN, y + 22, { width: INNER, align: 'center' });
    y += 62;

    // Método pago + notas
    const METHOD_LABELS = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia', check: 'Cheque', credit: 'Crédito' };
    doc.font('Helvetica').fontSize(8).fillColor(C.gray)
      .text(`Método de pago: ${METHOD_LABELS[paymentData.method] || paymentData.method || 'Efectivo'}`, MARGIN, y);
    y += 14;
    if (paymentData.notes) {
      doc.font('Helvetica').fontSize(8).fillColor(C.gray)
        .text(`Notas: ${paymentData.notes}`, MARGIN, y, { width: INNER });
      y += 14;
    }
    y += 6;

    // Resumen totales OT
    const totalOT  = parseFloat(order.total_amount || 0);
    const paidPrev = parseFloat(order.paid_amount  || 0);
    const thisPay  = parseFloat(paymentData.amount || 0);
    const newPaid  = paidPrev + thisPay;
    const balance  = totalOT - newPaid;

    doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER, y).strokeColor(C.border).lineWidth(0.5).stroke();
    y += 10;

    [
      ['Total orden',        COP(totalOT),  C.dark,   false],
      ['Pagos anteriores',   COP(paidPrev), C.gray,   false],
      ['Este pago',          COP(thisPay),  C.green,  true],
      ['Saldo pendiente',    COP(balance),  balance > 0 ? C.orange : C.green, true],
    ].forEach(([label, val, color, bold]) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(C.gray).text(label, MARGIN, y, { width: 130 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(color).text(val, MARGIN, y, { width: INNER, align: 'right' });
      y += 16;
    });

    if (balance <= 0) {
      y += 6;
      doc.roundedRect(MARGIN, y, INNER, 22, 5).fill(C.green);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(C.white)
        .text('ORDEN PAGADA COMPLETAMENTE', MARGIN, y + 5, { width: INNER, align: 'center' });
      y += 28;
    }

    // Firma
    y += 10;
    const sigW = (INNER - 20) / 2;
    [MARGIN, MARGIN + sigW + 20].forEach((sx, i) => {
      doc.moveTo(sx, y + 20).lineTo(sx + sigW, y + 20).strokeColor(C.lightGray).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(C.lightGray)
        .text(i === 0 ? 'Firma recibido' : 'Firma taller', sx, y + 24, { width: sigW, align: 'center' });
    });

    // Banda inferior
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(C.primary);
    doc.end();
  } catch (e) {
    console.error('Error generando recibo:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Error generando recibo' });
  }
};

/* ══════════════════════════════════════════════════════════════
   2. ORDEN DE INGRESO (con inventario de estado)
   ══════════════════════════════════════════════════════════════ */
const generateIntakeForm = async (res, order, tenant) => {
  try {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ingreso-${order.order_number}.pdf"`);
    doc.pipe(res);

    const MARGIN = 40;
    const PAGE_W = doc.page.width;
    const INNER  = PAGE_W - MARGIN * 2;

    let y = await drawHeader(doc, tenant, 'ORDEN DE INGRESO', 'Recepción de vehículo', order.order_number);

    // ── Sección vehículo + cliente ──
    const half = (INNER - 12) / 2;

    // Vehículo
    doc.roundedRect(MARGIN, y, half, 110, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('VEHÍCULO', MARGIN + 10, y + 8);
    const v = order.vehicle || {};
    [
      ['Placa',     v.plate || '—'],
      ['Marca',     v.brand || '—'],
      ['Modelo',    v.model || '—'],
      ['Año',       v.year || '—'],
      ['Color',     v.color || '—'],
      ['Km ingreso', order.mileage_in ? `${Number(order.mileage_in).toLocaleString('es-CO')} km` : '—'],
    ].forEach(([lbl, val], i) => {
      const ry = y + 20 + i * 15;
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(lbl, MARGIN + 10, ry, { width: 70 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(val, MARGIN + 82, ry, { width: half - 90 });
    });

    // Cliente
    const cx = MARGIN + half + 12;
    doc.roundedRect(cx, y, half, 110, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('CLIENTE', cx + 10, y + 8);
    const c = order.customer || {};
    const clientName = c.business_name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';
    [
      ['Nombre',   clientName],
      ['CC/NIT',   c.tax_id || '—'],
      ['Teléfono', c.phone || c.mobile || '—'],
      ['Email',    c.email || '—'],
    ].forEach(([lbl, val], i) => {
      const ry = y + 20 + i * 15;
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(lbl, cx + 10, ry, { width: 60 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(val, cx + 72, ry, { width: half - 80, ellipsis: true });
    });

    y += 120;

    // ── Fechas ──
    doc.roundedRect(MARGIN, y, INNER, 30, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    const dateW = INNER / 2;
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('Fecha de ingreso', MARGIN + 10, y + 8);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.dark).text(fmtDateTime(order.received_at), MARGIN + 10, y + 18);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('Entrega prometida', MARGIN + dateW + 10, y + 8);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(order.promised_at ? C.primary : C.lightGray)
      .text(order.promised_at ? fmtDateTime(order.promised_at) : 'Sin definir', MARGIN + dateW + 10, y + 18);
    y += 42;

    // ── Técnico ──
    const tech = order.technician;
    if (tech) {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('Técnico asignado:', MARGIN, y);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark)
        .text(`${tech.first_name} ${tech.last_name}`, MARGIN + 105, y);
      y += 18;
    }

    // ── Problema reportado ──
    if (order.problem_description) {
      doc.roundedRect(MARGIN, y, INNER, 60, 5).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('PROBLEMA REPORTADO POR EL CLIENTE', MARGIN + 10, y + 8);
      doc.font('Helvetica').fontSize(9).fillColor(C.dark)
        .text(order.problem_description, MARGIN + 10, y + 20, { width: INNER - 20, height: 35 });
      y += 72;
    }

    // ── INVENTARIO DE ESTADO ──────────────────────────────────────
    y += 6;
    doc.rect(MARGIN, y, INNER, 20).fill(C.primary);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white)
      .text('INVENTARIO DE ESTADO DEL VEHÍCULO AL INGRESO', MARGIN + 10, y + 5);
    y += 24;

    const checklist = order.checklist_in || {};

    // Nivel de combustible (gráfico)
    const fuelLevel = checklist.fuel_level || 0; // 0-4
    const fuelLabels = ['Vacío', '1/4', '1/2', '3/4', 'Lleno'];
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.gray).text('Nivel de combustible:', MARGIN, y);
    const fuelX0 = MARGIN + 120;
    for (let i = 0; i < 5; i++) {
      const bx = fuelX0 + i * 38;
      doc.roundedRect(bx, y - 2, 35, 16, 3)
        .fill(i <= fuelLevel ? '#22c55e' : C.border);
      doc.font('Helvetica').fontSize(7).fillColor(i <= fuelLevel ? C.white : C.gray)
        .text(fuelLabels[i], bx, y + 3, { width: 35, align: 'center' });
    }
    y += 22;

    // Items del checklist (dos columnas)
    const checkItems = [
      { key: 'estado_general', label: 'Estado general' },
      { key: 'testigos',        label: 'Testigos' },
      { key: 'tanque',          label: 'Tanque combustible' },
      { key: 'espejos',         label: 'Espejos' },
      { key: 'sillin',          label: 'Sillín' },
      { key: 'luces',           label: 'Luces' },
      { key: 'carenaje',        label: 'Carenaje / plásticos' },
      { key: 'llantas',         label: 'Llantas' },
      { key: 'rele_encendido',  label: 'Rele de encendido' },
    ];

    const colW = (INNER - 20) / 2;
    checkItems.forEach((item, idx) => {
      const col  = idx % 2;
      const row  = Math.floor(idx / 2);
      const ix   = MARGIN + col * (colW + 20);
      const iy   = y + row * 22;
      const val  = checklist[item.key];
      const mc   = val === true ? C.green : val === false ? C.red : C.lightGray;

      // Dibujar indicador visual sin caracteres Unicode
      doc.roundedRect(ix, iy, 16, 16, 3).fill(mc);
      if (val === true) {
        // Palomita: dos líneas
        doc.moveTo(ix + 3, iy + 8).lineTo(ix + 7, iy + 12).lineTo(ix + 13, iy + 4)
          .strokeColor(C.white).lineWidth(2).stroke();
      } else if (val === false) {
        // X: dos líneas cruzadas
        doc.moveTo(ix + 4, iy + 4).lineTo(ix + 12, iy + 12)
          .strokeColor(C.white).lineWidth(2).stroke();
        doc.moveTo(ix + 12, iy + 4).lineTo(ix + 4, iy + 12)
          .strokeColor(C.white).lineWidth(2).stroke();
      } else {
        // Circulo vacio (no aplica) - guion
        doc.moveTo(ix + 4, iy + 8).lineTo(ix + 12, iy + 8)
          .strokeColor(C.white).lineWidth(2).stroke();
      }

      doc.font('Helvetica').fontSize(8).fillColor(C.dark).text(item.label, ix + 20, iy + 3, { width: colW - 25 });
    });
    y += Math.ceil(checkItems.length / 2) * 22 + 10;

    // Observaciones de estado (daños, rayones, etc.)
    doc.roundedRect(MARGIN, y, INNER, 55, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('OBSERVACIONES DE ESTADO (rayones, golpes, faltantes)', MARGIN + 10, y + 8);
    if (checklist.observations) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.dark)
        .text(checklist.observations, MARGIN + 10, y + 22, { width: INNER - 20, height: 30 });
    }
    y += 65;

    // ── Notas del taller ──
    if (order.notes) {
      doc.roundedRect(MARGIN, y, INNER, 45, 5).strokeColor(C.border).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('NOTAS INTERNAS', MARGIN + 10, y + 8);
      doc.font('Helvetica').fontSize(8.5).fillColor(C.dark)
        .text(order.notes, MARGIN + 10, y + 20, { width: INNER - 20, height: 25 });
      y += 55;
    }

    // ── Firmas ──
    y = Math.max(y + 20, doc.page.height - 120);
    const sigW  = (INNER - 40) / 3;
    const sigLabels = ['Firma del cliente', 'Firma del técnico', 'Firma del administrador'];
    sigLabels.forEach((lbl, i) => {
      const sx = MARGIN + i * (sigW + 20);
      doc.moveTo(sx, y + 35).lineTo(sx + sigW, y + 35).strokeColor(C.lightGray).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(C.lightGray)
        .text(lbl, sx, y + 40, { width: sigW, align: 'center' });
    });

    // Acento inferior
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(C.primary);
    doc.end();
  } catch (e) {
    console.error('Error generando orden de ingreso:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Error generando orden de ingreso' });
  }
};

/* ══════════════════════════════════════════════════════════════
   3. OT COMPLETA (para imprimir / entregar al cierre)
   ══════════════════════════════════════════════════════════════ */
const generateWorkOrderPDF = async (res, order, tenant) => {
  try {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="OT-${order.order_number}.pdf"`);
    doc.pipe(res);

    const MARGIN = 40;
    const PAGE_W = doc.page.width;
    const INNER  = PAGE_W - MARGIN * 2;

    const statusLabels = {
      recibido: 'RECIBIDO', en_proceso: 'EN PROCESO', en_espera: 'EN ESPERA',
      listo: 'LISTO', entregado: 'ENTREGADO', cancelado: 'CANCELADO',
    };
    const statusColors = {
      recibido: C.primary, en_proceso: '#d97706', en_espera: '#f97316',
      listo: C.green, entregado: C.gray, cancelado: C.red,
    };

    let y = await drawHeader(doc, tenant, 'ORDEN DE TRABAJO', statusLabels[order.status] || '', order.order_number);

    // ── Datos principales ─────────────────────────────────────────
    const half = (INNER - 12) / 2;

    // Vehículo (izq)
    doc.roundedRect(MARGIN, y, half, 95, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('VEHÍCULO', MARGIN + 10, y + 8);
    const v = order.vehicle || {};
    [
      ['Placa', v.plate || '—'],
      ['Marca / Modelo', `${v.brand || '—'} ${v.model || ''}`.trim()],
      ['Año / Color', [v.year, v.color].filter(Boolean).join(' · ') || '—'],
      ['Km ingreso', order.mileage_in ? `${Number(order.mileage_in).toLocaleString('es-CO')} km` : '—'],
      ['Km salida',  order.mileage_out ? `${Number(order.mileage_out).toLocaleString('es-CO')} km` : '—'],
    ].forEach(([lbl, val], i) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(lbl, MARGIN + 10, y + 20 + i * 14, { width: 80 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(val, MARGIN + 92, y + 20 + i * 14, { width: half - 100 });
    });

    // Cliente (der)
    const cx = MARGIN + half + 12;
    doc.roundedRect(cx, y, half, 95, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('CLIENTE', cx + 10, y + 8);
    const cu = order.customer || {};
    const cName = cu.business_name || `${cu.first_name || ''} ${cu.last_name || ''}`.trim() || '—';
    [
      ['Nombre',   cName],
      ['CC/NIT',   cu.tax_id || '—'],
      ['Teléfono', cu.phone || cu.mobile || '—'],
      ['Técnico',  order.technician ? `${order.technician.first_name} ${order.technician.last_name}` : '—'],
    ].forEach(([lbl, val], i) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(lbl, cx + 10, y + 20 + i * 14, { width: 60 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(val, cx + 72, y + 20 + i * 14, { width: half - 80, ellipsis: true });
    });

    y += 107;

    // Fechas
    const fCols = [
      ['Recibido',  fmtDateTime(order.received_at)],
      ['Prometido', order.promised_at ? fmtDateTime(order.promised_at) : '—'],
      ['Entregado', order.delivered_at ? fmtDateTime(order.delivered_at) : '—'],
    ];
    const fdW = INNER / 3;
    doc.roundedRect(MARGIN, y, INNER, 26, 4).strokeColor(C.border).lineWidth(0.4).stroke();
    fCols.forEach(([lbl, val], i) => {
      const fx = MARGIN + i * fdW + 10;
      doc.font('Helvetica').fontSize(7).fillColor(C.gray).text(lbl, fx, y + 5, { width: fdW - 14 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(val, fx, y + 14, { width: fdW - 14 });
    });
    y += 36;

    // Problema + diagnóstico (side by side if both exist)
    const textSections = [
      ['PROBLEMA REPORTADO', order.problem_description],
      ['DIAGNÓSTICO TÉCNICO', order.diagnosis],
      ['TRABAJO REALIZADO',  order.work_performed],
    ].filter(([, v]) => v);

    textSections.forEach(([title, text]) => {
      const h = 50;
      if (y + h > 680) { doc.addPage(); y = 40; }
      doc.roundedRect(MARGIN, y, INNER, h, 4).strokeColor(C.border).lineWidth(0.4).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text(title, MARGIN + 10, y + 8);
      doc.font('Helvetica').fontSize(8.5).fillColor(C.dark)
        .text(text, MARGIN + 10, y + 20, { width: INNER - 20, height: h - 26, ellipsis: true });
      y += h + 8;
    });

    // ── Tabla de ítems ────────────────────────────────────────────
    if (y + 60 > 680) { doc.addPage(); y = 40; }

    doc.rect(MARGIN, y, INNER, 20).fill(C.primary);
    const TH = [
      { x: MARGIN + 4,  text: '#',              w: 16,  bold: true, color: C.white },
      { x: MARGIN + 22, text: 'DESCRIPCIÓN',    w: 220, bold: true, color: C.white },
      { x: MARGIN + 250,text: 'TIPO',           w: 55,  bold: true, color: C.white },
      { x: MARGIN + 308,text: 'CANT.',          w: 38,  bold: true, color: C.white, align: 'right' },
      { x: MARGIN + 350,text: 'P. UNIT.',       w: 72,  bold: true, color: C.white, align: 'right' },
      { x: MARGIN + 426,text: 'TOTAL',          w: 72,  bold: true, color: C.white, align: 'right' },
    ];
    tableRow(doc, TH, y + 1);
    y += 22;

    const items = order.items || [];
    items.forEach((item, idx) => {
      if (y + 20 > 700) { doc.addPage(); y = 40; }
      const bg = idx % 2 === 0 ? '#f8fafc' : null;
      const typeLabel = item.item_type === 'service' ? 'Servicio' : item.item_type === 'product' ? 'Repuesto' : 'Otro';
      tableRow(doc, [
        { x: MARGIN + 4,  text: idx + 1,                                              w: 16,  color: C.gray },
        { x: MARGIN + 22, text: item.product_name || item.product?.name || '—',       w: 220 },
        { x: MARGIN + 250,text: typeLabel,                                             w: 55,  color: C.gray },
        { x: MARGIN + 308,text: item.quantity,                                         w: 38,  align: 'right' },
        { x: MARGIN + 350,text: COP(item.unit_price),                                 w: 72,  align: 'right' },
        { x: MARGIN + 426,text: COP(item.total),                                      w: 72,  align: 'right', bold: true },
      ], y, 20, bg);
      doc.rect(MARGIN, y, INNER, 20).strokeColor(C.border).lineWidth(0.3).stroke();
      y += 20;
    });

    if (items.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.lightGray)
        .text('Sin ítems registrados', MARGIN + 10, y + 8);
      y += 28;
    }

    y += 10;

    // ── Totales ─────────────────────────────────────────────────
    const TW   = 210;
    const TX   = MARGIN + INNER - TW;
    const sub  = parseFloat(order.subtotal || 0);
    const tax  = parseFloat(order.tax_amount || 0);
    const disc = parseFloat(order.discount_amount || 0);
    const tot  = parseFloat(order.total_amount || 0);
    const paid = parseFloat(order.paid_amount || 0);
    const bal  = tot - paid;

    const totRows = [
      sub  > 0 ? ['Subtotal',        COP(sub),  C.dark,   false] : null,
      tax  > 0 ? ['IVA',             COP(tax),  C.dark,   false] : null,
      disc > 0 ? ['Descuento',       `- ${COP(disc)}`, C.orange, false] : null,
                 ['Total',           COP(tot),  C.primary, true],
      paid > 0 ? ['Pagado',          COP(paid), C.green,  false] : null,
      paid > 0 ? ['Saldo pendiente', COP(bal),  bal > 0 ? C.orange : C.green, true] : null,
    ].filter(Boolean);

    const totH = totRows.length * 18 + 16;
    doc.roundedRect(TX, y, TW, totH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    let ty = y + 8;
    totRows.forEach(([lbl, val, color, bold]) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 8).fillColor(C.gray)
        .text(lbl, TX + 10, ty, { width: 100 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(color)
        .text(val, TX + 10, ty, { width: TW - 18, align: 'right' });
      ty += 18;
    });
    y += totH + 20;

    // ── Notas ────────────────────────────────────────────────────
    if (order.notes && y < 680) {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('Observaciones: ', MARGIN, y, { continued: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(C.dark).text(order.notes, { width: INNER - 100 });
      y += 20;
    }

    // ── Firma cliente ────────────────────────────────────────────
    const sigArea = doc.page.height - 80;
    if (y < sigArea - 40) {
      const sigW2 = (INNER - 40) / 2;
      [MARGIN, MARGIN + sigW2 + 40].forEach((sx, i) => {
        doc.moveTo(sx, sigArea).lineTo(sx + sigW2, sigArea).strokeColor(C.lightGray).lineWidth(0.5).stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor(C.lightGray)
          .text(i === 0 ? 'Firma y C.C. del cliente' : 'Firma autorizada del taller', sx, sigArea + 6, { width: sigW2, align: 'center' });
      });
    }

    // Acento inferior
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(C.primary);
    doc.end();
  } catch (e) {
    console.error('Error generando OT:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Error generando OT' });
  }
};

module.exports = { generatePaymentReceipt, generateIntakeForm, generateWorkOrderPDF };