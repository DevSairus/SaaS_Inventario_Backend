// backend/src/services/ensambladora/cotizacionPdfService.js
//
// Documento de cotización (moto + matrícula + otros rubros) para
// entregarle al cliente. Deliberadamente NO reutiliza
// pdfService.js#generateSalePDF -- esa función está fuertemente acoplada
// al modelo Sale (impuestos, tenant.pdf_config, SaleItems, badges de
// pago/vencimiento) y forzar una cotización de moto a ese shape sería más
// frágil que escribir un generador propio con pdfkit directo (mismo motor
// que pdfService.js/workshopPdfService.js/comprobantePdfService.js).
//
// La cabecera (logo + datos del CSA + caja de tipo de documento) usa el
// mismo lenguaje visual que el PDF de OT -- ver pdfBranding.js.
const PDFDocument = require('pdfkit');
const { C, COP, fmtFecha, drawBrandedHeader } = require('./pdfBranding');

/**
 * Escribe el PDF directamente en `res`. `cotizacion` es la instancia
 * Sequelize (EnsambladoraCotizacion); `lineaNombre` viene resuelto aparte
 * porque el registro local solo guarda un snapshot de texto, no un include.
 * `tenant` (opcional) trae company_name/logo_url/etc. del CSA que cotiza.
 */
async function generarCotizacionPDF(res, { cotizacion, lineaNombre, tenant }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="cotizacion-${cotizacion.id}.pdf"`);
  doc.pipe(res);

  const MARGIN = 50;
  const INNER = doc.page.width - MARGIN * 2;

  let y = await drawBrandedHeader(doc, tenant, 'COTIZACIÓN', fmtFecha(cotizacion.fecha), `#${String(cotizacion.id).slice(0, 8).toUpperCase()}`);

  // ── Moto + Cliente, lado a lado (mismo patrón que la caja de OT) ───────
  const half = (INNER - 12) / 2;
  const boxH = 95;

  doc.roundedRect(MARGIN, y, half, boxH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('VEHÍCULO COTIZADO', MARGIN + 10, y + 8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.dark).text(lineaNombre || 'Moto', MARGIN + 10, y + 22, { width: half - 20 });
  if (cotizacion.vin) {
    doc.font('Helvetica').fontSize(8).fillColor(C.gray).text(`VIN: ${cotizacion.vin}`, MARGIN + 10, y + 44, { width: half - 20 });
  }
  if (cotizacion.tecnico_documento) {
    doc.font('Helvetica').fontSize(8).fillColor(C.gray).text(`Asesor: ${cotizacion.tecnico_documento}`, MARGIN + 10, y + 60, { width: half - 20 });
  }

  const cx = MARGIN + half + 12;
  doc.roundedRect(cx, y, half, boxH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('CLIENTE', cx + 10, y + 8);
  if (cotizacion.cliente_nombre) {
    [
      ['Nombre', cotizacion.cliente_nombre],
      ['Documento', cotizacion.cliente_documento || '—'],
      ['Teléfono', cotizacion.cliente_telefono || '—'],
    ].forEach(([lbl, val], i) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(lbl, cx + 10, y + 22 + i * 15, { width: 60 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(val, cx + 70, y + 22 + i * 15, { width: half - 80 });
    });
  } else {
    doc.font('Helvetica').fontSize(8.5).fillColor(C.lightGray).text('Cliente sin registrar todavía', cx + 10, y + 24, { width: half - 20 });
  }

  y += boxH + 12;

  // ── Tabla de ítems ───────────────────────────────────────────────────
  doc.rect(MARGIN, y, INNER, 20).fill(C.primary);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white);
  doc.text('CONCEPTO', MARGIN + 10, y + 6);
  doc.text('VALOR', MARGIN + INNER - 110, y + 6, { width: 100, align: 'right' });
  y += 20;

  const items = Array.isArray(cotizacion.items) ? cotizacion.items : [];
  items.forEach((item, i) => {
    if (y + 22 > 700) { doc.addPage(); y = 40; }
    if (i % 2 === 0) doc.rect(MARGIN, y, INNER, 22).fill(C.soft);
    doc.font('Helvetica').fontSize(9).fillColor(C.dark);
    doc.text(item.concepto || 'Ítem', MARGIN + 10, y + 7, { width: INNER - 130 });
    doc.font('Helvetica-Bold').text(COP(item.valor), MARGIN + INNER - 110, y + 7, { width: 100, align: 'right' });
    doc.rect(MARGIN, y, INNER, 22).strokeColor(C.border).lineWidth(0.3).stroke();
    y += 22;
  });

  y += 6;
  doc.roundedRect(MARGIN + INNER - 220, y, 220, 34, 5).fill(C.primary);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#dbeafe').text('TOTAL', MARGIN + INNER - 210, y + 8);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(C.white).text(COP(cotizacion.total), MARGIN + INNER - 220, y + 7, { width: 210, align: 'right' });
  y += 50;

  if (y < 700) {
    doc.font('Helvetica').fontSize(8).fillColor(C.gray).text(
      'Cotización sujeta a disponibilidad de inventario y variación de precios. No constituye una venta hasta su confirmación.',
      MARGIN, y, { width: INNER, align: 'center' }
    );
  }

  doc.end();
}

module.exports = { generarCotizacionPDF };
