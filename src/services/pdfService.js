const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DOCUMENT_TYPES = {
  factura:    { title: 'FACTURA',    numberLabel: 'FACTURA No.'    },
  remision:   { title: 'REMISIÓN',   numberLabel: 'REMISIÓN No.'   },
  cotizacion: { title: 'COTIZACIÓN', numberLabel: 'COTIZACIÓN No.' }
};

const downloadImage = (url) => {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const chunks = [];
    protocol.get(url, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
};

const generateSalePDF = async (res, sale, tenant) => {
  try {
    const docType = DOCUMENT_TYPES[sale.document_type] || DOCUMENT_TYPES.factura;
    // hide_remision_tax: si el tenant activa esta opción, la remisión oculta el IVA
    const hideRemisionTax = tenant?.features?.hide_remision_tax !== false
      ? (sale.document_type === 'remision')   // por defecto activo para remisiones
      : false;                                  // tenant desactivó la función
    const isRemision = hideRemisionTax;

    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${docType.title}-${sale.sale_number}.pdf"`);
    doc.pipe(res);

    /* ── PALETA ─────────────────────────────────────────────── */
    const red      = '#8b0000';
    const gray     = '#6b7280';
    const darkGray = '#374151';
    const softGray = '#f9fafb';
    const border   = '#e5e7eb';
    const borderMd = '#d1d5db';
    const lightBg  = '#f3f4f6';
    const black    = '#111827';
    const green    = '#059669';
    const orange   = '#ea580c';
    const white    = '#ffffff';

    const PAGE_W  = doc.page.width;
    const MARGIN  = 40;
    const INNER_W = PAGE_W - MARGIN * 2; // 532

    /* ── ACENTO SUPERIOR ────────────────────────────────────── */
    doc.rect(0, 0, PAGE_W, 5).fill(red);

    /* ══════════════════════════════════════════════════════════
       ENCABEZADO — Opción B
       ┌──────────────────────────────────────────────────────┐  ROW1
       │  [LOGO]   NOMBRE EMPRESA · NIT · tel · email  [DOC] │
       ├────────────────────┬──────────────────┬──────────────┤  ROW2
       │  CLIENTE           │  VEHÍCULO        │  ESTADO      │
       └────────────────────┴──────────────────┴──────────────┘
       ══════════════════════════════════════════════════════════ */
    let y = 16;

    const HDR_H  = 156;
    const ROW1_H = 64;
    const V2A    = 210;  // cliente | vehículo
    const V2B    = 380;  // vehículo | estado

    // Recuadro exterior
    doc.roundedRect(MARGIN, y, INNER_W, HDR_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();

    // Fondo suave ROW1
    doc.save();
    doc.roundedRect(MARGIN, y, INNER_W, ROW1_H, 5).clip();
    doc.rect(MARGIN, y, INNER_W, ROW1_H).fill(softGray);
    doc.restore();

    // Separador horizontal
    doc.moveTo(MARGIN, y + ROW1_H).lineTo(MARGIN + INNER_W, y + ROW1_H).strokeColor(border).lineWidth(0.5).stroke();

    // Separadores verticales ROW2
    doc.moveTo(MARGIN + V2A, y + ROW1_H).lineTo(MARGIN + V2A, y + HDR_H).strokeColor(border).lineWidth(0.5).stroke();
    doc.moveTo(MARGIN + V2B, y + ROW1_H).lineTo(MARGIN + V2B, y + HDR_H).strokeColor(border).lineWidth(0.5).stroke();

    /* ── ROW1: Logo · Empresa · Tipo doc ── */
    const LOGO_W = 72, LOGO_H = 44;
    const LOGO_X = MARGIN + 12;
    const LOGO_Y = y + (ROW1_H - LOGO_H) / 2;

    let logoDrawn = false;
    if (tenant.logo_url) {
      try {
        let src;
        if (tenant.logo_url.startsWith('http')) {
          src = await downloadImage(tenant.logo_url);
        } else {
          const p = path.join(__dirname, '../../uploads/logos', tenant.logo_url);
          if (fs.existsSync(p)) src = p;
        }
        if (src) {
          doc.image(src, LOGO_X, LOGO_Y, { height: LOGO_H, fit: [LOGO_W, LOGO_H] });
          logoDrawn = true;
        }
      } catch (e) { /* sin logo */ }
    }

    const EMP_X = logoDrawn ? LOGO_X + LOGO_W + 12 : MARGIN + 14;
    const DOC_W = 160;
    const EMP_W = INNER_W - (EMP_X - MARGIN) - DOC_W - 16;

    doc.font('Helvetica-Bold').fontSize(12).fillColor(darkGray)
      .text(tenant.company_name || 'Empresa', EMP_X, y + 12, { width: EMP_W });

    const empDetails = [
      tenant.tax_id ? `NIT: ${tenant.tax_id}` : null,
      tenant.address,
      [tenant.phone, tenant.email].filter(Boolean).join('  ·  ')
    ].filter(Boolean);

    doc.font('Helvetica').fontSize(7.5).fillColor(gray);
    let ey = y + 27;
    empDetails.forEach(line => { doc.text(line, EMP_X, ey, { width: EMP_W }); ey += 11; });

    const DX = MARGIN + INNER_W - DOC_W;
    const DW = DOC_W - 10;

    doc.font('Helvetica-Bold').fontSize(17).fillColor(red).text(docType.title, DX, y + 10, { width: DW, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray).text(sale.sale_number, DX, y + 32, { width: DW, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(formatDate(sale.sale_date), DX, y + 44, { width: DW, align: 'center' });

    /* ── ROW2: CLIENTE | VEHÍCULO | ESTADO ── */
    const R2Y = y + ROW1_H;

    // Celda 1 — CLIENTE
    const CX = MARGIN + 12, CW = V2A - 20, CY = R2Y + 10;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('CLIENTE', CX, CY);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(sale.customer_name || '', CX, CY + 12, { width: CW });
    const cDetails = [
      sale.customer_tax_id,
      sale.Customer?.phone || sale.customer_phone,
      sale.Customer?.email || sale.customer_email,
      sale.Customer?.address || sale.customer_address,
    ].filter(Boolean);
    let cy2 = CY + 25;
    doc.font('Helvetica').fontSize(7.5).fillColor(gray);
    cDetails.slice(0, 3).forEach(d => { doc.text(d, CX, cy2, { width: CW, ellipsis: true }); cy2 += 11; });

    // Celda 2 — VEHÍCULO
    const VX = MARGIN + V2A + 12, VW = V2B - V2A - 20, VY = R2Y + 10;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('VEHÍCULO', VX, VY);
    if (sale.vehicle_plate) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(`Placa: ${sale.vehicle_plate}`, VX, VY + 12, { width: VW });
    }
    if (sale.mileage) {
      doc.font('Helvetica').fontSize(8.5).fillColor(darkGray)
        .text(`Km: ${Number(sale.mileage).toLocaleString('es-CO')}`, VX, VY + (sale.vehicle_plate ? 28 : 12), { width: VW });
    }
    if (!sale.vehicle_plate && !sale.mileage) {
      doc.font('Helvetica').fontSize(8).fillColor(border).text('—', VX, VY + 12);
    }

    // Celda 3 — ESTADO
    const SX = MARGIN + V2B + 12, SW = INNER_W - V2B - 20, SY = R2Y + 10;
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('ESTADO', SX, SY);

    const paymentStatus = sale.payment_status || 'pending';
    const saleStatus    = sale.status || 'draft';
    const isConfirmed   = saleStatus !== 'draft';

    // Solo mostrar badge si la venta está confirmada (no borrador)
    if (isConfirmed) {
      let badgeColor, badgeLabel;

      if (sale.document_type === 'cotizacion') {
        badgeColor = '#7c3aed'; badgeLabel = 'COTIZACIÓN';
      } else if (paymentStatus === 'paid') {
        badgeColor = green;     badgeLabel = '✓  PAGADO';
      } else if (paymentStatus === 'partial') {
        badgeColor = '#d97706'; badgeLabel = 'PAGO PARCIAL';
      } else {
        badgeColor = orange;    badgeLabel = 'A CRÉDITO';
      }

      doc.roundedRect(SX, SY + 12, SW, 18, 4).fill(badgeColor);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(white).text(badgeLabel, SX, SY + 17, { width: SW, align: 'center' });

      if (sale.due_date && paymentStatus !== 'paid') {
        doc.font('Helvetica').fontSize(7).fillColor(gray)
          .text(`Vence: ${formatDate(sale.due_date)}`, SX, SY + 36, { width: SW, align: 'center' });
      }
    }

    /* ══════════════════════════════════════════════════════════
       TABLA DE ÍTEMS
       ══════════════════════════════════════════════════════════ */
    y = y + HDR_H + 14;

    const cols = { desc: MARGIN, qty: 330, price: 390, total: 470 };

    doc.rect(MARGIN, y, INNER_W, 22).fill(red);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(white)
      .text('DESCRIPCIÓN',     cols.desc + 6, y + 6)
      .text('CANT.',           cols.qty,       y + 6)
      .text('PRECIO UNITARIO', cols.price,     y + 6)
      .text('TOTAL',           cols.total,     y + 6);

    y += 24;

    const items = sale.SaleItems || sale.items || [];
    items.forEach((item, index) => {
      if (y > 620) { doc.addPage(); y = 40; }
      if (index % 2 === 0) doc.rect(MARGIN, y, INNER_W, 20).fill(lightBg);

      // Precio unitario: en remisión mostrar precio con IVA incluido (unit_price + tax por unidad)
      const qty = parseFloat(item.quantity) || 1;
      const unitPriceDisplay = isRemision
        ? parseFloat(item.total) / qty          // total ya tiene IVA incluido
        : parseFloat(item.unit_price);

      doc.font('Helvetica').fontSize(9).fillColor(black)
        .text(item.Product?.name || item.product_name, cols.desc + 6, y + 5, { width: 264 })
        .text(String(item.quantity),              cols.qty,   y + 5)
        .text(formatCurrency(unitPriceDisplay),   cols.price, y + 5)
        .text(formatCurrency(item.total),         cols.total, y + 5);
      doc.rect(MARGIN, y, INNER_W, 20).strokeColor(border).lineWidth(0.4).stroke();
      y += 20;
    });

    /* ══════════════════════════════════════════════════════════
       OBSERVACIONES DE PAGO (izq) + TOTALES (der) — mismo nivel
       ══════════════════════════════════════════════════════════ */
    y += 14;

    const paidAmt  = parseFloat(sale.paid_amount || 0);
    const totalAmt = parseFloat(sale.total_amount);
    const balance  = totalAmt - paidAmt;
    const payHist  = sale.payment_history || [];

    // Leer configuración de observaciones del tenant
    const pdfConfig    = tenant.pdf_config || {};
    const paymentNotes = pdfConfig.payment_notes?.trim();
    const legalNote    = pdfConfig.legal_note?.trim();

    // Calcular alto del bloque (basado en filas de totales)
    let totRows = isRemision ? 1 : 2; // remision: solo total | factura: subtotal + total
    if (!isRemision)                        totRows++; // IVA
    if ((sale.discount_amount || 0) > 0)   totRows++;
    if (paidAmt > 0)                        totRows++;
    if (balance > 0 && paidAmt > 0)         totRows++;
    const BAND_H = totRows * 18 + 20;

    // Dimensiones
    const TOT_W = 230;
    const TOT_X = MARGIN + INNER_W - TOT_W;
    const LBL_X = TOT_X + 12;
    const VAL_X = TOT_X + TOT_W - 90;
    const VAL_W = 82;
    const OBS_W = TOT_X - MARGIN - 10;

    // Guardar y antes de que drawRow lo avance, para calcular el fondo real
    const bandTopY = y;

    // ── Caja observaciones de pago (izquierda) ──────────────────
    if (paymentNotes) {
      doc.roundedRect(MARGIN, bandTopY - 6, OBS_W, BAND_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(gray)
        .text('OBSERVACIONES DE PAGO', MARGIN + 10, bandTopY + 2);
      doc.font('Helvetica').fontSize(8).fillColor(black)
        .text(paymentNotes, MARGIN + 10, bandTopY + 14, { width: OBS_W - 20, height: BAND_H - 26, ellipsis: true });
    }

    // ── Caja totales (derecha) ───────────────────────────────────
    doc.roundedRect(TOT_X, bandTopY - 6, TOT_W, BAND_H, 5).strokeColor(borderMd).lineWidth(0.5).stroke();

    const drawRow = (label, value, color = darkGray, bold = false, big = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 10 : 8.5).fillColor(color)
        .text(label, LBL_X, y, { width: 90 })
        .text(value, VAL_X, y,  { width: VAL_W, align: 'right' });
      y += 18;
    };

    if (isRemision) {
      // Remisión: IVA incluido en el total, no se discrimina
      if ((sale.discount_amount || 0) > 0) drawRow('Descuento', `- ${formatCurrency(sale.discount_amount)}`);
    } else {
      // Factura / Cotización: desglosar subtotal + IVA + descuento
      drawRow('Subtotal', formatCurrency(sale.subtotal));
      drawRow('IVA',      formatCurrency(sale.tax_amount));
      if ((sale.discount_amount || 0) > 0) drawRow('Descuento', `- ${formatCurrency(sale.discount_amount)}`);
    }

    doc.moveTo(LBL_X, y - 3).lineTo(TOT_X + TOT_W - 8, y - 3).strokeColor(borderMd).lineWidth(0.4).stroke();

    drawRow(
      sale.document_type === 'cotizacion' ? 'Total cotizado' : 'Total a pagar',
      formatCurrency(sale.total_amount), red, true, true
    );
    if (paidAmt > 0)                    drawRow('Pagado',          formatCurrency(paidAmt),   green,  false);
    if (balance > 0 && paidAmt > 0)     drawRow('Saldo pendiente', formatCurrency(balance),   orange, true);

    // ── Texto legal centrado DEBAJO de ambas cajas ─────────────
    // bandTopY es donde empezaron los recuadros, así el fondo es exacto
    const bandBottomY = bandTopY - 6 + BAND_H;
    if (legalNote) {
      const legalY = bandBottomY + 6;
      doc.font('Helvetica').fontSize(7).fillColor(gray)
        .text(legalNote, MARGIN, legalY, { width: INNER_W, align: 'center' });
      y = legalY + 14;
    } else {
      y = bandBottomY + 6;
    }

    /* ══════════════════════════════════════════════════════════
       HISTORIAL DE PAGOS
       ══════════════════════════════════════════════════════════ */
    if (payHist.length > 0) {
      y += 20;
      if (y > 550) { doc.addPage(); y = 40; }

      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(gray).text('HISTORIAL DE PAGOS', MARGIN, y);
      y += 14;

      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(gray)
        .text('FECHA',  MARGIN,       y)
        .text('MONTO',  MARGIN + 110, y)
        .text('MÉTODO', MARGIN + 210, y)
        .text('NOTAS',  MARGIN + 310, y);
      y += 10;

      doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(border).lineWidth(0.4).stroke();
      y += 6;

      payHist.forEach((pmt, idx) => {
        if (y > 700) { doc.addPage(); y = 40; }
        doc.font('Helvetica').fontSize(8).fillColor(black)
          .text(formatDate(pmt.date),           MARGIN,       y)
          .text(formatCurrency(pmt.amount),     MARGIN + 110, y)
          .text(pmt.method || 'Efectivo',        MARGIN + 210, y)
          .text(pmt.notes || '-',                MARGIN + 310, y, { width: 210 });
        y += 14;
        if (idx < payHist.length - 1) {
          doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(lightBg).lineWidth(0.3).stroke();
          y += 4;
        }
      });
    }

    /* ══════════════════════════════════════════════════════════
       NOTAS DE LA VENTA (campo notes)
       ══════════════════════════════════════════════════════════ */
    if (sale.notes && sale.notes.trim()) {
      y += 20;
      if (y > 650) { doc.addPage(); y = 40; }
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(gray).text('OBSERVACIONES', MARGIN, y);
      y += 12;
      doc.font('Helvetica').fontSize(9).fillColor(black).text(sale.notes, MARGIN, y, { width: INNER_W });
    }

    /* ── ACENTO INFERIOR ────────────────────────────────────── */
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(red);

    doc.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ message: 'Error generando PDF' });
  }
};

/* ── HELPERS ────────────────────────────────────────────────── */
function formatDate(date) {
  return new Date(date).toLocaleDateString('es-CO');
}

function formatCurrency(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', maximumFractionDigits: 0
  }).format(value || 0);
}


/* ══════════════════════════════════════════════════════════════
   RECIBO DE PAGO / ANTICIPO  (A5 portrait)
   ══════════════════════════════════════════════════════════════ */
const generatePaymentReceiptPDF = async (res, sale, tenant, payment) => {
  try {
    const doc = new PDFDocument({ size: 'A5', margin: 30, bufferPages: true });
    const recNum = payment.receipt_number || `REC-${String((payment.index ?? 0) + 1).padStart(4, '0')}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="recibo-${recNum}.pdf"`);
    doc.pipe(res);

    const PAGE_W  = doc.page.width;
    const MARGIN  = 30;
    const INNER_W = PAGE_W - MARGIN * 2;

    const blue   = '#1e40af';
    const green  = '#059669';
    const orange = '#d97706';
    const gray   = '#6b7280';
    const dark   = '#111827';
    const light  = '#eff6ff';
    const white  = '#ffffff';
    const border = '#e5e7eb';

    doc.rect(0, 0, PAGE_W, 5).fill(blue);

    let y = 14;

    doc.font('Helvetica-Bold').fontSize(16).fillColor(blue)
      .text('RECIBO DE PAGO', MARGIN, y, { width: INNER_W, align: 'center' });
    y += 22;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(dark)
      .text(tenant.company_name || '', MARGIN, y, { width: INNER_W, align: 'center' });
    y += 12;
    const empLine = [tenant.tax_id ? 'NIT ' + tenant.tax_id : null, tenant.phone].filter(Boolean).join('  .  ');
    if (empLine) {
      doc.font('Helvetica').fontSize(7).fillColor(gray)
        .text(empLine, MARGIN, y, { width: INNER_W, align: 'center' });
      y += 12;
    }
    y += 4;

    doc.roundedRect(MARGIN, y, INNER_W, 30, 5).fill(blue);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(white)
      .text(recNum, MARGIN, y + 4, { width: INNER_W, align: 'center' });

    const dtStr = payment.date
      ? new Date(payment.date).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : formatDate(new Date());
    doc.font('Helvetica').fontSize(7.5).fillColor('#bfdbfe')
      .text(dtStr, MARGIN, y + 18, { width: INNER_W, align: 'center' });
    y += 40;

    const clientName = sale.Customer
      ? (sale.Customer.business_name || ((sale.Customer.first_name || '') + ' ' + (sale.Customer.last_name || '')).trim())
      : (sale.customer_name || '—');

    const rows = [
      ['Documento', sale.sale_number],
      ['Cliente',   clientName],
    ];
    if (sale.vehicle_plate) rows.push(['Vehiculo', sale.vehicle_plate]);
    if (sale.Customer && sale.Customer.tax_id) rows.push(['CC / NIT', sale.Customer.tax_id]);

    const rowH = 18;
    doc.roundedRect(MARGIN, y, INNER_W, rows.length * rowH + 14, 4).strokeColor(border).lineWidth(0.5).stroke();
    let ry = y + 8;
    rows.forEach(function(r) {
      doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(r[0], MARGIN + 10, ry, { width: 85 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(dark).text(r[1], MARGIN + 98, ry, { width: INNER_W - 108, ellipsis: true });
      ry += rowH;
    });
    y += rows.length * rowH + 22;

    doc.roundedRect(MARGIN, y, INNER_W, 52, 6).fill(light);
    doc.font('Helvetica').fontSize(8).fillColor(gray).text('VALOR RECIBIDO', MARGIN, y + 10, { width: INNER_W, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(22).fillColor(blue).text(formatCurrency(payment.amount), MARGIN, y + 22, { width: INNER_W, align: 'center' });
    y += 62;

    const METHODS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Credito' };
    doc.font('Helvetica').fontSize(8).fillColor(gray).text('Metodo: ' + (METHODS[payment.method] || payment.method || 'Efectivo'), MARGIN, y);
    if (payment.notes) {
      y += 13;
      doc.font('Helvetica').fontSize(7.5).fillColor(gray).text('Nota: ' + payment.notes, MARGIN, y, { width: INNER_W });
    }
    y += 16;

    const total    = parseFloat(sale.total_amount || 0);
    const allPaid  = parseFloat(sale.paid_amount  || 0);
    const thisPay  = parseFloat(payment.amount);
    const paidPrev = Math.max(0, allPaid - thisPay);
    const balance  = total - allPaid;

    doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(border).lineWidth(0.5).stroke();
    y += 10;

    [
      ['Total del documento', formatCurrency(total),    dark,   false],
      ['Pagos anteriores',    formatCurrency(paidPrev), gray,   false],
      ['Este pago',           formatCurrency(thisPay),  green,  true ],
      ['Saldo pendiente',     formatCurrency(balance),  balance > 0 ? orange : green, true],
    ].forEach(function(row) {
      var lbl = row[0], val = row[1], color = row[2], bold = row[3];
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9 : 8).fillColor(gray).text(lbl, MARGIN, y, { width: 140 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9.5 : 8).fillColor(color).text(val, MARGIN, y, { width: INNER_W, align: 'right' });
      y += 16;
    });

    if (balance <= 0) {
      y += 4;
      doc.roundedRect(MARGIN, y, INNER_W, 20, 4).fill(green);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(white).text('DOCUMENTO CANCELADO EN SU TOTALIDAD', MARGIN, y + 5, { width: INNER_W, align: 'center' });
      y += 26;
    }

    const sigY = Math.max(y + 16, doc.page.height - 70);
    const sigW = (INNER_W - 20) / 2;
    [[MARGIN, 'Firma quien recibe'], [MARGIN + sigW + 20, 'Firma y sello empresa']].forEach(function(pair) {
      doc.moveTo(pair[0], sigY).lineTo(pair[0] + sigW, sigY).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7).fillColor('#9ca3af').text(pair[1], pair[0], sigY + 5, { width: sigW, align: 'center' });
    });

    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(blue);
    doc.end();
  } catch (e) {
    console.error('Error generando recibo de pago:', e);
    if (!res.headersSent) res.status(500).json({ message: 'Error generando recibo' });
  }
};

module.exports = { generateSalePDF, generatePaymentReceiptPDF };