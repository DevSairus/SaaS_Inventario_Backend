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
  const bufferMode = !res;
  let bufferPromise = null;

  try {
    const docType  = DOCUMENT_TYPES[sale.document_type] || DOCUMENT_TYPES.factura;
    // Un borrador todavía no tiene document_type asignado (se elige recién al
    // confirmar la venta, ver sales.controller.js) -- por eso siempre cae en
    // el fallback DOCUMENT_TYPES.factura de arriba y mostraba "FACTURA" aunque
    // el documento no fuera ni siquiera una factura todavía. Mientras esté en
    // Borrador no debe mostrarse ningún tipo de documento fiscal como válido.
    const isDraftDoc = (sale.status || 'draft') === 'draft';
    const docTitle = isDraftDoc ? 'BORRADOR' : docType.title;
    // hide_remision_tax: oculta IVA en remisiones (activado por defecto)
    const hideRemisionTax = tenant?.features?.hide_remision_tax !== false
      ? (sale.document_type === 'remision')
      : false;
    // hide_invoice_tax: oculta IVA en facturas (desactivado por defecto)
    const hideInvoiceTax = !!(tenant?.features?.hide_invoice_tax)
      && sale.document_type === 'factura';
    // isRemision = cualquier caso donde se debe ocultar el desglose de IVA
    const isRemision = hideRemisionTax || hideInvoiceTax;

    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

    if (!bufferMode) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${docType.title}-${sale.sale_number}.pdf"`);
      doc.pipe(res);
    } else {
      const chunks = [];
      bufferPromise = new Promise((resolve, reject) => {
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });
    }

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
    const LOGO_W = 90, LOGO_H = 44;
    const LOGO_X = MARGIN + 12;
    const LOGO_Y = y + (ROW1_H - LOGO_H) / 2;

    let logoDrawn = false;
    if (tenant.logo_url) {
      try {
        let src;
        // Logo siempre desde URL (Cloudinary) — sin acceso a disco local
        if (tenant.logo_url.startsWith('http')) {
          src = await downloadImage(tenant.logo_url);
        }
        // Logos sin URL HTTP (legacy disco) simplemente no se muestran
        if (src) {
          // ⚠️ Solo usar `fit` — NO pasar height por separado.
          // Si se pasan ambos, PDFKit escala por height e ignora el ancho del fit,
          // haciendo que logos anchos se desborden sobre el texto.
          doc.image(src, LOGO_X, LOGO_Y, { fit: [LOGO_W, LOGO_H], align: 'left', valign: 'center' });
          logoDrawn = true;
        }
      } catch (e) { /* sin logo */ }
    }

    const EMP_X = logoDrawn ? LOGO_X + LOGO_W + 14 : MARGIN + 14;
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

    doc.font('Helvetica-Bold').fontSize(17).fillColor(red).text(docTitle, DX, y + 10, { width: DW, align: 'center' });
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
    // Se muestra si la venta tiene datos de vehículo (ej: generada desde OT),
    // o si el tenant tiene habilitado el campo. Se oculta solo cuando el tenant
    // desactivó el campo Y la venta no tiene datos de vehículo.
    const vehicleEnabled = tenant?.features?.vehicle_field_enabled !== false;
    const hasVehicleData = !!(sale.vehicle_plate || sale.vehicle_brand);
    const VX = MARGIN + V2A + 12, VW = V2B - V2A - 20, VY = R2Y + 10;
    if (vehicleEnabled || hasVehicleData) {
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor(gray).text('VEHÍCULO', VX, VY);
      if (hasVehicleData) {
        let vy = VY + 12;
        if (sale.vehicle_plate) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray).text(`Placa: ${sale.vehicle_plate}`, VX, vy, { width: VW });
          vy += 14;
        }
        const vehicleDesc = [
          sale.vehicle_brand,
          sale.vehicle_model,
          sale.vehicle_year,
          sale.vehicle_color ? `(${sale.vehicle_color})` : null,
        ].filter(Boolean).join(' ');
        if (vehicleDesc) {
          doc.font('Helvetica').fontSize(8).fillColor(darkGray);
          doc.text(vehicleDesc, VX, vy, { width: VW });
          vy += doc.heightOfString(vehicleDesc, { width: VW }) + 2;
        }
        if (sale.mileage) {
          const kmLine = `Km: ${sale.mileage.toLocaleString('es-CO')}`;
          doc.font('Helvetica').fontSize(8).fillColor(gray);
          doc.text(kmLine, VX, vy, { width: VW });
          vy += doc.heightOfString(kmLine, { width: VW }) + 2;
        }
        if (sale.technician_name) {
          const techLine = `Técnico: ${sale.technician_name}`;
          doc.font('Helvetica').fontSize(8).fillColor(gray);
          doc.text(techLine, VX, vy, { width: VW });
        }
      } else {
        doc.font('Helvetica').fontSize(8).fillColor(border).text('—', VX, VY + 12);
      }
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

    // Encabezado con esquinas superiores redondeadas (el rect plano cubre
    // la mitad inferior del redondeo para empatar con las filas de abajo)
    doc.roundedRect(MARGIN, y, INNER_W, 22, 4).fill(red);
    doc.rect(MARGIN, y + 11, INNER_W, 11).fill(red);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(white)
      .text('DESCRIPCIÓN',     cols.desc + 6, y + 6)
      .text('CANT.',           cols.qty,       y + 6)
      .text('PRECIO UNITARIO', cols.price,     y + 6)
      .text('TOTAL',           cols.total,     y + 6);

    y += 24;

    const items = sale.SaleItems || sale.items || [];
    const itemsTop = y;
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

    // Recuadro exterior con esquinas redondeadas para toda la tabla
    // (encabezado + filas), solo si no se paginó en medio de la tabla
    const tableTop = itemsTop - 24;
    if (items.length > 0 && y > tableTop) {
      doc.roundedRect(MARGIN, tableTop, INNER_W, y - tableTop, 5)
        .strokeColor(borderMd).lineWidth(0.6).stroke();
    }

    /* ══════════════════════════════════════════════════════════
       DATOS DEL VEHÍCULO FACTURADO (VIN, motor, color, etc.)
       Solo aparece si algún ítem es un producto tipo 'vehicle' con su
       ficha de Vehicle asociada -- una venta normal de repuestos/servicios
       nunca dispara este bloque, pero la venta de una moto/carro nuevo sí,
       para que la factura sirva como soporte ante el organismo de tránsito.
       ══════════════════════════════════════════════════════════ */
    const vehicleItems = items.filter(item => item.product?.product_type === 'vehicle' && item.product?.vehicle);
    if (vehicleItems.length > 0) {
      y += 14;
      for (const item of vehicleItems) {
        const v = item.product.vehicle;
        const fields = [
          ['Marca',    v.brand],
          ['Línea',    v.model],
          ['Modelo',   v.year],
          ['Color',    v.color],
          ['VIN / Chasis', v.vin],
          ['Motor',    v.engine_number],
          ['Cilindraje', v.engine],
          ['Placa',    v.plate],
        ].filter(([, val]) => val);

        if (fields.length === 0) continue;

        const rowsCount = Math.ceil(fields.length / 2);
        const boxH = 22 + rowsCount * 14;
        if (y + boxH > 700) { doc.addPage(); y = 40; }

        doc.roundedRect(MARGIN, y, INNER_W, boxH, 5).strokeColor(borderMd).lineWidth(0.5).stroke();
        doc.font('Helvetica-Bold').fontSize(8).fillColor(gray)
          .text(`DATOS DEL VEHÍCULO — ${item.product?.name || item.product_name}`, MARGIN + 10, y + 8);

        const colW = (INNER_W - 20) / 2;
        fields.forEach(([label, val], idx) => {
          const col = idx % 2;
          const row = Math.floor(idx / 2);
          const fx = MARGIN + 10 + col * colW;
          const fy = y + 22 + row * 14;
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(gray).text(`${label}:`, fx, fy, { continued: true, width: colW });
          doc.font('Helvetica').fontSize(7.5).fillColor(black).text(` ${val}`, { width: colW - 60 });
        });

        y += boxH + 8;
      }
    }

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
    const taxBreakdown = sale.tax_breakdown || [];
    const allTaxes = taxBreakdown.filter(t => t.type === 'tax');
    let totRows = isRemision ? 1 : 1 + (allTaxes.length || 1); // subtotal + impuestos (o IVA fallback)
    if ((sale.discount_amount || 0) > 0)          totRows++;
    if ((sale.global_discount_amount || 0) > 0)   totRows++;
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
      // Remisión: impuestos incluidos en el total, no se discriminan
      if ((sale.discount_amount || 0) > 0) drawRow('Descuento', `- ${formatCurrency(sale.discount_amount)}`);
    } else {
      // Factura / Cotización: desglosar subtotal + impuestos + descuento
      drawRow('Subtotal', formatCurrency(sale.subtotal));
      // Mostrar todos los impuestos desde tax_breakdown
      const allTaxes = taxBreakdown.filter(t => t.type === 'tax');
      for (const tax of allTaxes) {
        drawRow(tax.name, formatCurrency(tax.amount));
      }
      if (allTaxes.length === 0) {
        // Fallback: si no hay breakdown, usar tax_amount como IVA
        drawRow('IVA', formatCurrency(sale.tax_amount));
      }
      if ((sale.discount_amount || 0) > 0) drawRow('Descuento', `- ${formatCurrency(sale.discount_amount)}`);
    }
    // Descuento global -- independiente de discount_amount (suma de
    // descuentos por línea); se resta después de impuestos, en ambos
    // formatos (remisión y factura/cotización).
    if ((sale.global_discount_amount || 0) > 0) drawRow('Descuento global', `- ${formatCurrency(sale.global_discount_amount)}`);

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

    /* ══════════════════════════════════════════════════════════
       DIAGRAMA DE INTERVENCIÓN (si la cotización tiene marcas)
       Mismo bloque (imagen + tabla en dos columnas) que ya se usa en
       workshopPdfService.js para la OT — se reutiliza acá para que las
       cotizaciones con diagnóstico marcado también lo muestren en su PDF
       y en la vista pública (que sirve este mismo PDF).
       ══════════════════════════════════════════════════════════ */
    const diagMarks = sale.diagnosis_marks || [];
    if (diagMarks.length > 0) {
      const { renderDiagramToPng, SEVERITY_COLORS } = require('./workshopPdfService');

      const diagramMap = {};
      diagMarks.forEach(m => {
        const tpl = m.diagram_template;
        if (!tpl) return;
        if (!diagramMap[tpl.id]) diagramMap[tpl.id] = { template: tpl, marks: [] };
        diagramMap[tpl.id].marks.push(m);
      });

      y += 20;
      if (y > 600) { doc.addPage(); y = 40; }
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(gray).text('DIAGNÓSTICO / DIAGRAMA DE INTERVENCIÓN', MARGIN, y);
      y += 16;

      for (const [, { template: tpl, marks: dMarks }] of Object.entries(diagramMap)) {
        const imgW = 230;
        const imgH = imgW * 0.667;
        const titleH = 14;

        const tableX = MARGIN + imgW + 16;
        const tableW = INNER_W - imgW - 16;
        const colW = [18, 68, 34, 48, tableW - 18 - 68 - 34 - 48];
        const headers = ['#', 'Parte', 'Lado', 'Sev.', 'Observación'];

        doc.font('Helvetica').fontSize(6.5);
        const rowHeights = dMarks.map(m =>
          Math.max(11, doc.heightOfString(m.observation || '', { width: colW[4] - 4 }) + 2)
        );
        const tableH = 13 + rowHeights.reduce((a, b) => a + b, 0);
        const blockH = titleH + Math.max(imgH, tableH) + 10;

        if (y + blockH > doc.page.height - 100) { doc.addPage(); y = 40; }

        doc.font('Helvetica-Bold').fontSize(9).fillColor(black)
          .text(`DIAGNÓSTICO — ${tpl.name}`, MARGIN, y);
        y += titleH;
        const blockTop = y;

        try {
          const pngBuf = await renderDiagramToPng(tpl.image_path, tpl.view_box, tpl.points, dMarks);
          doc.image(pngBuf, MARGIN, blockTop, { fit: [imgW, imgH] });
        } catch (e) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(gray)
            .text('(Error al renderizar diagrama)', MARGIN, blockTop, { width: imgW });
        }

        let ty = blockTop;
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(black);
        headers.forEach((h, i) => {
          const hx = tableX + colW.slice(0, i).reduce((a, b) => a + b, 0);
          doc.text(h, hx, ty, { width: colW[i], align: i === 0 ? 'center' : 'left' });
        });
        ty += 10;
        doc.moveTo(tableX, ty).lineTo(tableX + tableW, ty).strokeColor(border).lineWidth(0.3).stroke();
        ty += 3;

        doc.font('Helvetica').fontSize(6.5).fillColor(gray);
        dMarks.forEach((m, idx) => {
          const pt = (tpl.points || []).find(p => p.point_number === m.point_number);
          const sevLabel = { revisar: 'Revisar', cambiar_pronto: 'Cambiar pronto', urgente: 'Urgente' }[m.severity] || m.severity;
          const vals = [String(m.point_number), pt?.part_name || '—', m.side || '—', sevLabel, m.observation || ''];
          vals.forEach((v, i) => {
            const cx = tableX + colW.slice(0, i).reduce((a, b) => a + b, 0);
            doc.fillColor(i === 3 ? (SEVERITY_COLORS[m.severity] || gray) : gray)
              .text(v, cx + 2, ty, { width: colW[i] - 4, align: i === 0 ? 'center' : 'left' });
          });
          ty += rowHeights[idx];
        });

        y = blockTop + Math.max(imgH, tableH) + 10;
      }
    }

    /* ── ACENTO INFERIOR ────────────────────────────────────── */
    doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(red);

    doc.end();
    if (bufferMode) return await bufferPromise;

  } catch (error) {
    console.error(error);
    if (!bufferMode && !res.headersSent) res.status(500).json({ message: 'Error generando PDF' });
    if (bufferMode) throw error;
  }
};

// Wrapper que devuelve Buffer — usado por sendWhatsApp
const generateSalePDFBuffer = (sale, tenant) => generateSalePDF(null, sale, tenant);

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
  const bufferMode = !res;
  let bufferPromise = null;

  try {
    const doc = new PDFDocument({ size: 'A5', margin: 30, bufferPages: true });
    const recNum = payment.receipt_number || `REC-${String((payment.index ?? 0) + 1).padStart(4, '0')}`;

    if (!bufferMode) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="recibo-${recNum}.pdf"`);
      doc.pipe(res);
    } else {
      const chunks = [];
      bufferPromise = new Promise((resolve, reject) => {
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });
    }

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
    if (bufferMode) return await bufferPromise;
  } catch (e) {
    console.error('Error generando recibo de pago:', e);
    if (!bufferMode && !res.headersSent) res.status(500).json({ message: 'Error generando recibo' });
    if (bufferMode) throw e;
  }
};

const generatePaymentReceiptPDFBuffer = (sale, tenant, payment) =>
  generatePaymentReceiptPDF(null, sale, tenant, payment);

/* ══════════════════════════════════════════════════════════════
   CUADRE DE CAJA / FLUJO DE CAJA (LETTER portrait)
   cashFlow = { summary: {total_in, total_out, net, total_transactions},
                by_day: [...], transactions: [...] } — misma forma que
   devuelve GET /api/cashflow.
   ══════════════════════════════════════════════════════════════ */
const SOURCE_LABELS = {
  sale: 'Venta',
  purchase: 'Compra',
  expense: 'Gasto',
  work_order: 'Abono OT',
  customer_advance: 'Anticipo recibido',
  customer_advance_refund: 'Devolución anticipo',
};

// Los valores ya vienen como 'YYYY-MM-DD' (fecha de negocio, sin hora) —
// se formatean por texto, sin pasar por Date(), para no reintroducir
// corrimientos de zona horaria.
function formatDateStr(isoDateStr) {
  if (!isoDateStr) return '—';
  const [y, m, d] = isoDateStr.split('-');
  if (!y || !m || !d) return isoDateStr;
  return `${d}/${m}/${y}`;
}

const generateCashFlowPDF = async (res, cashFlow, tenant, filters = {}, generatedByName = '') => {
  const bufferMode = !res;
  let bufferPromise = null;

  try {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true });

    if (!bufferMode) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Cuadre-de-Caja-${filters.from_date || ''}_${filters.to_date || ''}.pdf"`);
      doc.pipe(res);
    } else {
      const chunks = [];
      bufferPromise = new Promise((resolve, reject) => {
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });
    }

    /* ── PALETA (misma que el resto de los PDF) ─────────────── */
    const red      = '#8b0000';
    const gray     = '#6b7280';
    const darkGray = '#374151';
    const softGray = '#f9fafb';
    const border   = '#e5e7eb';
    const borderMd = '#d1d5db';
    const black    = '#111827';
    const green    = '#059669';
    const redAmt   = '#dc2626';
    const white    = '#ffffff';

    const PAGE_W  = doc.page.width;
    const MARGIN  = 40;
    const INNER_W = PAGE_W - MARGIN * 2;

    const drawTopBar = () => doc.rect(0, 0, PAGE_W, 5).fill(red);
    drawTopBar();

    /* ── ENCABEZADO ──────────────────────────────────────────── */
    let y = 20;

    if (tenant.logo_url && tenant.logo_url.startsWith('http')) {
      try {
        const src = await downloadImage(tenant.logo_url);
        doc.image(src, MARGIN, y, { fit: [70, 36], align: 'left', valign: 'center' });
      } catch (e) { /* sin logo */ }
    }

    doc.font('Helvetica-Bold').fontSize(9).fillColor(darkGray)
      .text(tenant.company_name || 'Empresa', MARGIN + 80, y, { width: INNER_W - 240 });
    doc.font('Helvetica').fontSize(7.5).fillColor(gray)
      .text(tenant.tax_id ? `NIT: ${tenant.tax_id}` : '', MARGIN + 80, y + 13, { width: INNER_W - 240 });

    doc.font('Helvetica-Bold').fontSize(16).fillColor(red)
      .text('CUADRE DE CAJA', MARGIN, y, { width: INNER_W, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor(gray)
      .text(`Periodo: ${formatDateStr(filters.from_date) || 'inicio'} — ${formatDateStr(filters.to_date) || 'hoy'}`,
        MARGIN, y + 18, { width: INNER_W, align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor(gray)
      .text(`Generado: ${new Date().toLocaleString('es-CO')}${generatedByName ? ' · ' + generatedByName : ''}`,
        MARGIN, y + 30, { width: INNER_W, align: 'right' });

    y += 55;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(border).lineWidth(0.5).stroke();
    y += 16;

    /* ── TARJETAS DE RESUMEN ─────────────────────────────────── */
    const summary = cashFlow.summary || { total_in: 0, total_out: 0, net: 0, total_transactions: 0 };
    const cardW = (INNER_W - 20) / 3;
    const cards = [
      { label: 'ENTRADAS', value: summary.total_in, color: green },
      { label: 'SALIDAS',  value: summary.total_out, color: redAmt },
      { label: 'NETO DEL PERIODO', value: summary.net, color: summary.net >= 0 ? darkGray : redAmt },
    ];
    cards.forEach((card, i) => {
      const cx = MARGIN + i * (cardW + 10);
      doc.roundedRect(cx, y, cardW, 46, 5).fillAndStroke(softGray, borderMd);
      doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(card.label, cx + 10, y + 8);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(card.color).text(formatCurrency(card.value), cx + 10, y + 21);
    });
    y += 62;

    /* ── DESGLOSE POR ORIGEN ─────────────────────────────────── */
    const bySource = { sale: 0, purchase: 0, expense: 0 };
    (cashFlow.transactions || []).forEach(t => { bySource[t.source] = (bySource[t.source] || 0) + t.amount; });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray).text('DESGLOSE POR ORIGEN', MARGIN, y);
    y += 13;
    doc.font('Helvetica').fontSize(8).fillColor(black)
      .text(`Ventas (entradas): ${formatCurrency(bySource.sale)}    ·    Compras (salidas): ${formatCurrency(bySource.purchase)}    ·    Gastos (salidas): ${formatCurrency(bySource.expense)}`,
        MARGIN, y, { width: INNER_W });
    y += 22;

    /* ── TABLA DE MOVIMIENTOS ────────────────────────────────── */
    const COLS = { date: MARGIN, type: MARGIN + 60, source: MARGIN + 120, ref: MARGIN + 185, detail: MARGIN + 280, method: MARGIN + 410, amount: MARGIN + INNER_W - 80 };

    const drawTableHeader = () => {
      doc.roundedRect(MARGIN, y, INNER_W, 18, 3).fill(darkGray);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(white)
        .text('FECHA', COLS.date + 6, y + 5)
        .text('TIPO', COLS.type + 6, y + 5)
        .text('ORIGEN', COLS.source + 6, y + 5)
        .text('REFERENCIA', COLS.ref + 6, y + 5)
        .text('DETALLE', COLS.detail + 6, y + 5)
        .text('MÉTODO', COLS.method + 6, y + 5)
        .text('MONTO', COLS.amount, y + 5, { width: MARGIN + INNER_W - COLS.amount - 6, align: 'right' });
      y += 22;
    };

    doc.font('Helvetica-Bold').fontSize(8).fillColor(darkGray).text(`MOVIMIENTOS (${cashFlow.transactions?.length || 0})`, MARGIN, y);
    y += 14;
    drawTableHeader();

    const transactions = [...(cashFlow.transactions || [])].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    if (transactions.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(gray).text('Sin movimientos en el periodo seleccionado.', MARGIN, y);
      y += 16;
    }

    transactions.forEach((t, idx) => {
      if (y > 730) {
        doc.addPage();
        drawTopBar();
        y = 40;
        drawTableHeader();
      }
      const rowColor = t.direction === 'in' ? green : redAmt;
      doc.font('Helvetica').fontSize(7.8).fillColor(black)
        .text(formatDateStr(t.date), COLS.date + 6, y, { width: COLS.type - COLS.date - 8 })
        .text(t.direction === 'in' ? 'Entrada' : 'Salida', COLS.type + 6, y, { width: COLS.source - COLS.type - 8 })
        .text(SOURCE_LABELS[t.source] || t.source || '—', COLS.source + 6, y, { width: COLS.ref - COLS.source - 8 })
        .text(t.reference || '—', COLS.ref + 6, y, { width: COLS.detail - COLS.ref - 8, ellipsis: true })
        .text(t.detail || '—', COLS.detail + 6, y, { width: COLS.method - COLS.detail - 8, ellipsis: true })
        .text(t.method || '—', COLS.method + 6, y, { width: COLS.amount - COLS.method - 12, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(rowColor)
        .text(`${t.direction === 'in' ? '+' : '-'}${formatCurrency(t.amount)}`, COLS.amount, y, { width: MARGIN + INNER_W - COLS.amount - 6, align: 'right' });
      y += 13;
      if (idx < transactions.length - 1) {
        doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(border).lineWidth(0.3).stroke();
        y += 4;
      }
    });

    /* ── LÍNEA TOTAL ─────────────────────────────────────────── */
    y += 10;
    if (y > 740) { doc.addPage(); drawTopBar(); y = 40; }
    doc.moveTo(MARGIN, y).lineTo(MARGIN + INNER_W, y).strokeColor(borderMd).lineWidth(0.8).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(darkGray)
      .text('NETO DEL PERIODO:', COLS.detail, y)
      .fillColor(summary.net >= 0 ? green : redAmt)
      .text(formatCurrency(summary.net), COLS.amount, y, { width: MARGIN + INNER_W - COLS.amount - 6, align: 'right' });

    /* ── PIE DE PÁGINA CON NUMERACIÓN ────────────────────────── */
    const pageRange = doc.bufferedPageRange();
    for (let i = 0; i < pageRange.count; i++) {
      doc.switchToPage(i);
      doc.rect(0, doc.page.height - 5, PAGE_W, 5).fill(red);
      doc.font('Helvetica').fontSize(7).fillColor(gray)
        .text(`Página ${i + 1} de ${pageRange.count}`, MARGIN, doc.page.height - 24, { width: INNER_W, align: 'center' });
    }

    doc.end();
    if (bufferMode) return await bufferPromise;

  } catch (error) {
    console.error(error);
    if (!bufferMode && !res.headersSent) res.status(500).json({ message: 'Error generando cuadre de caja' });
    if (bufferMode) throw error;
  }
};

module.exports = { generateSalePDF, generateSalePDFBuffer, generatePaymentReceiptPDF, generatePaymentReceiptPDFBuffer, generateCashFlowPDF };