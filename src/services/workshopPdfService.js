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
    // Rutas locales (ej. /uploads/workshop/foto.jpg) — leer directo del disco
    if (url.startsWith('/uploads/')) {
      try {
        const filePath = path.join(__dirname, '..', '..', url);
        return resolve(fs.readFileSync(filePath));
      } catch (e) { return reject(e); }
    }
    const proto = url.startsWith('https') ? https : http;
    const chunks = [];
    proto.get(url, res => {
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

// Los diagramas base son imágenes WEBP servidas por el frontend
// (public/assets/diagrams/...) — el backend las trae por HTTP, no las lee
// del disco (frontend y backend son despliegues separados).
const loadDiagramImageBuffer = imagePath => {
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return downloadImage(`${base}/assets/diagrams/${imagePath}`);
};

// ── Renderizar diagrama (imagen WEBP + marcas superpuestas) a PNG buffer ──
const SEVERITY_COLORS = {
  revisar: '#2563eb',
  cambiar_pronto: '#d97706',
  urgente: '#dc3545',
};

async function renderDiagramToPng(imagePath, viewBox, points, marks) {
  const sharp = require('sharp');
  const { Resvg } = require('@resvg/resvg-js');

  if (!imagePath) throw new Error('Diagrama sin image_path — falta subir el archivo WEBP');

  const webpBuffer = await loadDiagramImageBuffer(imagePath);
  const bgMeta = await sharp(webpBuffer).metadata();
  const targetWidth = bgMeta.width || 800;

  // SVG transparente solo con los círculos/números de las marcas, en las
  // mismas coordenadas (unidades de view_box) que usa el frontend. Si el
  // punto trae label_dx/label_dy (números que quedarían pegados o encima de
  // la pieza), el círculo se dibuja desplazado + una línea guía + un puntito
  // exacto sobre la pieza — igual que en DiagramMapEditor/WorkOrderPublicPage.
  const markSvgParts = (marks || []).map(m => {
    const pt = (points || []).find(p => p.point_number === m.point_number);
    if (!pt) return '';
    const color = SEVERITY_COLORS[m.severity] || '#2563eb';
    const hasOffset = !!(pt.label_dx || pt.label_dy);
    const lx = pt.x + (pt.label_dx || 0);
    const ly = pt.y + (pt.label_dy || 0);
    const leader = hasOffset
      ? `<line x1="${pt.x}" y1="${pt.y}" x2="${lx}" y2="${ly}" stroke="${color}" stroke-width="1.25" opacity="0.85"/>
         <circle cx="${pt.x}" cy="${pt.y}" r="3" fill="${color}" stroke="#fff" stroke-width="1"/>`
      : '';
    return `${leader}
            <circle cx="${lx}" cy="${ly}" r="12" fill="${color}" fill-opacity="0.85" stroke="#fff" stroke-width="2"/>
            <text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="10" font-family="DejaVu Sans" fill="#fff" font-weight="bold">${pt.point_number}</text>`;
  }).join('\n');
  const overlaySvg = `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans">${markSvgParts}</svg>`;

  // NOTA: antes usaba `loadSystemFonts: true` + `defaultFontFamily: 'Arial'`.
  // En producción el backend corre en Docker `node:20-alpine`, que no trae
  // NINGUNA fuente instalada — resvg no encontraba con qué dibujar el <text>
  // y el número quedaba invisible (los círculos/líneas sí se ven porque son
  // formas vectoriales, no necesitan fuente). Por eso solo fallaba en el PDF
  // y no en las vistas del navegador (el navegador del cliente sí tiene
  // fuentes). Fix: empaquetar una fuente TTF con el propio repo y decirle a
  // resvg que la use directamente, sin depender de lo que tenga el SO.
  const FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
  const resvg = new Resvg(overlaySvg, {
    fitTo: { mode: 'width', value: targetWidth },
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Sans',
    },
    background: 'rgba(0,0,0,0)',
  });
  const overlayPng = resvg.render().asPng();

  return sharp(webpBuffer)
    .composite([{ input: overlayPng, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

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
      // Logo siempre desde URL (Cloudinary) — sin acceso a disco local
      let src = tenant.logo_url.startsWith('http')
        ? await downloadImage(tenant.logo_url)
        : null; // logos legacy en disco no se renderizan en Vercel
      if (src) {
        // ⚠️ Solo usar `fit` — NO pasar height por separado.
        doc.image(src, MARGIN + 10, y + 8, { fit: [80, 52], align: 'left', valign: 'center' });
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

    // ── Tabla de ítems (repuestos y servicios — la mano de obra se muestra
    //    aparte, en la caja de "Proceso Calidad y Servicio al Cliente") ────
    if (y + 60 > 680) { doc.addPage(); y = 40; }

    const allItems   = order.items || [];
    // item_type real en WorkOrderItem: 'repuesto' | 'servicio' | 'mano_obra'
    const laborItems = allItems.filter(i => i.item_type === 'mano_obra');
    const lineItems  = allItems.filter(i => i.item_type !== 'mano_obra');
    const laborTotal = laborItems.reduce((s, i) => s + parseFloat(i.total || 0), 0);

    doc.rect(MARGIN, y, INNER, 20).fill(C.primary);
    const TH = [
      { x: MARGIN + 4,   text: 'CANT.',        w: 40,  bold: true, color: C.white, align: 'right' },
      { x: MARGIN + 50,  text: 'DESCRIPCIÓN',  w: 290, bold: true, color: C.white },
      { x: MARGIN + 346, text: 'V. UNITARIO',  w: 78,  bold: true, color: C.white, align: 'right' },
      { x: MARGIN + 430, text: 'V. TOTAL',     w: 68,  bold: true, color: C.white, align: 'right' },
    ];
    tableRow(doc, TH, y + 1);
    y += 22;

    lineItems.forEach((item, idx) => {
      if (y + 20 > 700) { doc.addPage(); y = 40; }
      const bg = idx % 2 === 0 ? '#f8fafc' : null;
      tableRow(doc, [
        { x: MARGIN + 4,   text: item.quantity,                                       w: 40,  align: 'right' },
        { x: MARGIN + 50,  text: item.product_name || item.product?.name || '—',      w: 290 },
        { x: MARGIN + 346, text: COP(item.unit_price),                                w: 78,  align: 'right' },
        { x: MARGIN + 430, text: COP(item.total),                                     w: 68,  align: 'right', bold: true },
      ], y, 20, bg);
      doc.rect(MARGIN, y, INNER, 20).strokeColor(C.border).lineWidth(0.3).stroke();
      y += 20;
    });

    if (lineItems.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.lightGray)
        .text('Sin repuestos o servicios registrados', MARGIN + 10, y + 8);
      y += 28;
    }

    y += 10;

    // ── Proceso Calidad y Servicio al Cliente + Resumen de Valores ────────
    // (misma fila, lado a lado — igual que el formato de referencia)
    const qc = order.quality_checklist || {};
    const qcChecklist = [
      ['Limpieza final',        !!qc.limpieza_final],
      ['Torques finales',       !!qc.torques_finales],
      ['Entrega de repuestos',  !!qc.entrega_repuestos],
    ];

    const sub  = parseFloat(order.subtotal || 0);
    const tax  = parseFloat(order.tax_amount || 0);
    const disc = parseFloat(order.discount_amount || 0);
    const tot  = parseFloat(order.total_amount || 0);
    const paid = parseFloat(order.paid_amount || 0);
    const bal  = tot - paid;

    // El IVA solo se muestra si el tenant/los ítems realmente lo generaron
    // (tax_amount > 0) — si el taller no es responsable de IVA o todos los
    // ítems son exentos, la fila desaparece, no se muestra "$0".
    const totRows = [
      sub  > 0 ? ['Subtotal',        COP(sub),  C.dark,   false] : null,
      tax  > 0 ? ['IVA',             COP(tax),  C.dark,   false] : null,
      disc > 0 ? ['Descuento',       `- ${COP(disc)}`, C.orange, false] : null,
                 ['Total a pagar',   COP(tot),  C.primary, true],
      paid > 0 ? ['Pagado',          COP(paid), C.green,  false] : null,
      paid > 0 ? ['Saldo pendiente', COP(bal),  bal > 0 ? C.orange : C.green, true] : null,
    ].filter(Boolean);

    const boxGap = 12;
    const boxW   = (INNER - boxGap) / 2;
    const qcX    = MARGIN;
    const totX   = MARGIN + boxW + boxGap;
    const totH   = totRows.length * 18 + 24;
    const qcH    = 24 /* mano de obra */ + 12 /* separador */ + 16 /* subtítulo */ + qcChecklist.length * 14 + 12;
    const boxH   = Math.max(totH, qcH, 90);

    if (y + boxH > 700) { doc.addPage(); y = 40; }

    // Caja izquierda: Proceso Calidad y Servicio al Cliente
    doc.roundedRect(qcX, y, boxW, boxH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.rect(qcX, y, boxW, 18).fill(C.soft);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.dark)
      .text('PROCESO CALIDAD Y SERVICIO AL CLIENTE', qcX + 10, y + 5, { width: boxW - 20 });

    let qy = y + 26;
    doc.font('Helvetica').fontSize(8).fillColor(C.gray).text('Mano de obra', qcX + 10, qy, { width: 100 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.dark).text(COP(laborTotal), qcX + 10, qy, { width: boxW - 18, align: 'right' });
    qy += 20;
    doc.moveTo(qcX + 10, qy).lineTo(qcX + boxW - 10, qy).strokeColor(C.border).lineWidth(0.4).stroke();
    qy += 10;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('CONTROL DE CALIDAD', qcX + 10, qy, { width: boxW - 20, align: 'center' });
    qy += 15;
    qcChecklist.forEach(([lbl, val]) => {
      doc.font('Helvetica').fontSize(8).fillColor(C.gray).text(lbl, qcX + 10, qy, { width: boxW - 70 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(val ? C.green : C.lightGray)
        .text(val ? 'SÍ' : 'NO', qcX + 10, qy, { width: boxW - 18, align: 'right' });
      qy += 14;
    });

    // Caja derecha: Resumen de Valores
    doc.roundedRect(totX, y, boxW, boxH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    doc.rect(totX, y, boxW, 18).fill(C.soft);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.dark).text('RESUMEN DE VALORES', totX + 10, y + 5);
    let ty = y + 26;
    totRows.forEach(([lbl, val, color, bold]) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 8).fillColor(C.gray)
        .text(lbl, totX + 10, ty, { width: 100 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor(color)
        .text(val, totX + 10, ty, { width: boxW - 18, align: 'right' });
      ty += 18;
    });

    y += boxH + 16;

    // ── Notas ────────────────────────────────────────────────────
    if (order.notes && y < 660) {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text('Observaciones: ', MARGIN, y, { continued: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(C.dark).text(order.notes, { width: INNER - 100 });
      y += 20;
    }

    // ── Fotos adjuntas (ingreso / entrega) ─────────────────────────
    // Usa photos_in/photos_out del modelo WorkOrder — ya se cargan desde la
    // app al recibir/entregar el vehículo, pero antes no se veían en el PDF.
    const photosIn  = Array.isArray(order.photos_in)  ? order.photos_in.filter(p => p?.url)  : [];
    const photosOut = Array.isArray(order.photos_out) ? order.photos_out.filter(p => p?.url) : [];

    if (photosIn.length > 0 || photosOut.length > 0) {
      const THUMB = 60;
      const MAX_THUMBS = 3;
      const rowH = THUMB + 26;
      if (y + rowH > 700) { doc.addPage(); y = 40; }
      const halfW = (INNER - 20) / 2;

      const drawThumbs = async (label, photos, x) => {
        if (photos.length === 0) return;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.gray).text(label, x, y);
        let px = x;
        for (const p of photos.slice(0, MAX_THUMBS)) {
          try {
            const buf = await downloadImage(p.url);
            doc.roundedRect(px, y + 12, THUMB, THUMB, 3).strokeColor(C.border).lineWidth(0.5).stroke();
            doc.image(buf, px + 1, y + 13, { fit: [THUMB - 2, THUMB - 2] });
          } catch { /* si una foto falla en descargar, se omite sin romper el PDF */ }
          px += THUMB + 8;
        }
        if (photos.length > MAX_THUMBS) {
          doc.font('Helvetica').fontSize(7.5).fillColor(C.gray)
            .text(`+${photos.length - MAX_THUMBS} más`, px + 4, y + 12 + THUMB / 2 - 5);
        }
      };

      await drawThumbs('FOTOS DE INGRESO', photosIn, MARGIN);
      await drawThumbs('FOTOS DE ENTREGA', photosOut, MARGIN + halfW + 20);
      y += rowH;
    }

    // ── Diagrama de intervención (si hay marcas) ────────────────────
    const marks = order.diagnosis_marks || [];
    if (marks.length > 0) {
      // Agrupar marcas por diagrama
      const diagramMap = {};
      marks.forEach(m => {
        const tpl = m.diagram_template;
        if (!tpl) return;
        if (!diagramMap[tpl.id]) diagramMap[tpl.id] = { template: tpl, marks: [] };
        diagramMap[tpl.id].marks.push(m);
      });

      for (const [, { template: tpl, marks: dMarks }] of Object.entries(diagramMap)) {
        // Imagen a la izquierda, tabla de marcas a la derecha (en vez de apilados)
        // Imagen más grande (antes 200pt) — las fuentes fuente son WEBP a 1536x1024,
        // así que hay margen de sobra de resolución para crecer sin pixelarse.
        const imgW = 240;
        const imgH = imgW * 0.667; // 3:2 aspect ratio
        const titleH = 14;

        const tableX = MARGIN + imgW + 16;
        const tableW = INNER - imgW - 16;
        const colW = [18, 68, 34, 48, tableW - 18 - 68 - 34 - 48];
        const headers = ['#', 'Parte', 'Lado', 'Sev.', 'Observación'];

        // Precalcular alto real de la tabla (para saltar de página con el bloque completo, no a medias).
        // OJO: hay que medir TODAS las columnas que pueden envolver a 2+ líneas
        // (Parte y Sev. también envuelven con nombres largos como "Brazo de
        // control inferior" o "Cambiar pronto"), no solo Observación — medir
        // solo esa columna era la causa de que una fila corta "montara" su
        // texto sobre la fila siguiente cuando Parte o Sev. sí envolvían.
        doc.font('Helvetica').fontSize(6.5);
        const rowHeights = dMarks.map(m => {
          const pt = (tpl.points || []).find(p => p.point_number === m.point_number);
          const sevLabel = { revisar: 'Revisar', cambiar_pronto: 'Cambiar pronto', urgente: 'Urgente' }[m.severity] || m.severity;
          const h = Math.max(
            doc.heightOfString(pt?.part_name || '—', { width: colW[1] - 4 }),
            doc.heightOfString(sevLabel, { width: colW[3] - 4 }),
            doc.heightOfString(m.observation || '', { width: colW[4] - 4 }),
          );
          return Math.max(11, h + 3);
        });
        const tableH = 13 + rowHeights.reduce((a, b) => a + b, 0);
        const blockH = titleH + Math.max(imgH, tableH) + 10;

        if (y + blockH > doc.page.height - 100) { doc.addPage(); y = 40; }

        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.dark)
          .text(`DIAGNÓSTICO — ${tpl.name}`, MARGIN, y);
        y += titleH;
        const blockTop = y;

        // Columna izquierda: imagen del diagrama
        try {
          const pngBuf = await renderDiagramToPng(
            tpl.image_path, tpl.view_box, tpl.points, dMarks
          );
          doc.image(pngBuf, MARGIN, blockTop, { fit: [imgW, imgH] });
        } catch (e) {
          console.error('Error renderizando diagrama:', e.message);
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.lightGray)
            .text('(Error al renderizar diagrama)', MARGIN, blockTop, { width: imgW });
        }

        // Columna derecha: tabla de marcas
        let ty = blockTop;
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.dark);
        headers.forEach((h, i) => {
          const hx = tableX + colW.slice(0, i).reduce((a, b) => a + b, 0);
          doc.text(h, hx, ty, { width: colW[i], align: i === 0 ? 'center' : 'left' });
        });
        ty += 10;
        doc.moveTo(tableX, ty).lineTo(tableX + tableW, ty).strokeColor(C.lightGray).lineWidth(0.3).stroke();
        ty += 3;

        doc.font('Helvetica').fontSize(6.5).fillColor(C.gray);
        dMarks.forEach((m, idx) => {
          const pt = (tpl.points || []).find(p => p.point_number === m.point_number);
          const sevLabel = { revisar: 'Revisar', cambiar_pronto: 'Cambiar pronto', urgente: 'Urgente' }[m.severity] || m.severity;
          const vals = [
            String(m.point_number),
            pt?.part_name || '—',
            m.side || '—',
            sevLabel,
            m.observation || '',
          ];
          vals.forEach((v, i) => {
            const cx = tableX + colW.slice(0, i).reduce((a, b) => a + b, 0);
            doc.fillColor(i === 3 ? (SEVERITY_COLORS[m.severity] || C.gray) : C.gray)
              .text(v, cx + 2, ty, { width: colW[i] - 4, align: i === 0 ? 'center' : 'left' });
          });
          ty += rowHeights[idx];
        });

        y = blockTop + Math.max(imgH, tableH) + 10;
      }
    }

    // ── Firmas: cliente, técnico y supervisor ──────────────────────
    const sigArea = doc.page.height - 80;
    if (y > sigArea - 40) { doc.addPage(); y = 40; }
    const sigW3 = (INNER - 60) / 3;
    const sigLabels = ['Firma y C.C. del cliente', 'Firma y C.C. del técnico', 'Firma y C.C. del supervisor'];
    [MARGIN, MARGIN + sigW3 + 30, MARGIN + 2 * (sigW3 + 30)].forEach((sx, i) => {
      doc.moveTo(sx, sigArea).lineTo(sx + sigW3, sigArea).strokeColor(C.lightGray).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(C.lightGray)
        .text(sigLabels[i], sx, sigArea + 6, { width: sigW3, align: 'center' });
    });

    // Acento inferior
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(C.primary);
    doc.end();
  } catch (e) {
    console.error('Error generando OT:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Error generando OT' });
  }
};

/* ══════════════════════════════════════════════════════════════
   BUFFER WRAPPERS — necesarios para Vercel serverless
   (doc.pipe(res) no funciona en serverless; se genera el PDF
    completo en memoria y se envía de una sola vez)
   ══════════════════════════════════════════════════════════════ */
const { Writable } = require('stream');

function createBufferStream() {
  const chunks = [];
  let resolveBuffer, rejectBuffer;
  const bufferPromise = new Promise((res, rej) => {
    resolveBuffer = res;
    rejectBuffer  = rej;
  });

  const stream = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    }
  });

  // Propiedades que los generadores usan en el objeto `res`
  stream.setHeader   = () => {};
  stream.headersSent = false;
  stream.status      = () => ({ json: () => {} });

  stream.on('finish', () => resolveBuffer(Buffer.concat(chunks)));
  stream.on('error',  rejectBuffer);

  return { stream, bufferPromise };
}

const generatePaymentReceiptBuffer = async (order, tenant, paymentData) => {
  const { stream, bufferPromise } = createBufferStream();
  await generatePaymentReceipt(stream, order, tenant, paymentData);
  return bufferPromise;
};

const generateIntakeFormBuffer = async (order, tenant) => {
  const { stream, bufferPromise } = createBufferStream();
  await generateIntakeForm(stream, order, tenant);
  return bufferPromise;
};

const generateWorkOrderPDFBuffer = async (order, tenant) => {
  const { stream, bufferPromise } = createBufferStream();
  await generateWorkOrderPDF(stream, order, tenant);
  return bufferPromise;
};

module.exports = {
  generatePaymentReceipt,
  generateIntakeForm,
  generateWorkOrderPDF,
  generatePaymentReceiptBuffer,
  generateIntakeFormBuffer,
  generateWorkOrderPDFBuffer,
};