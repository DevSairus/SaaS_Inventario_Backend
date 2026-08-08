// backend/src/services/ensambladora/comprobantePdfService.js
//
// Comprobante imprimible de revisión/garantía para entregarle al cliente en
// el mostrador -- deliberadamente simple (no reutiliza workshopPdfService.js,
// que está acoplado a WorkOrder y a diagramas de intervención que no
// aplican acá). Mismo motor (pdfkit) que pdfService.js/workshopPdfService.js.
//
// La cabecera (logo + datos del CSA + caja de tipo de documento) usa el
// mismo lenguaje visual que el PDF de OT -- ver pdfBranding.js.
const PDFDocument = require('pdfkit');
const { C, COP, fmtFecha, drawBrandedHeader } = require('./pdfBranding');

const TITULOS = {
  revision: 'COMPROBANTE DE REVISIÓN',
  garantia: 'COMPROBANTE DE GARANTÍA',
};

const ESTADO_BADGE = {
  revision: { label: 'COMPLETADA', color: C.green },
  garantia_cerrada: { label: 'CERRADA', color: C.gray },
  garantia_en_proceso: { label: 'EN PROCESO', color: C.orange },
};

/**
 * Escribe el PDF directamente en `res` (Content-Type application/pdf).
 * `registro` es la instancia Sequelize (EnsambladoraOrdenRevision o
 * EnsambladoraOrdenGarantia); `shareUrl` es opcional (null si nunca se
 * generó un share_token para este registro). `tenant` (opcional) trae
 * company_name/logo_url/etc. del CSA que atendió el vehículo.
 */
async function generarComprobantePDF(res, { tipo, registro, shareUrl, tenant }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="comprobante-${tipo}-${registro.id}.pdf"`);
  doc.pipe(res);

  const MARGIN = 50;
  const INNER = doc.page.width - MARGIN * 2;

  const badgeKey = tipo === 'revision' ? 'revision' : (registro.cerrada ? 'garantia_cerrada' : 'garantia_en_proceso');
  const badge = ESTADO_BADGE[badgeKey];

  let y = await drawBrandedHeader(doc, tenant, TITULOS[tipo] || 'COMPROBANTE', `Emitido el ${fmtFecha(new Date())}`, `#${String(registro.id).slice(0, 8).toUpperCase()}`);

  // ── Vehículo + Estado, lado a lado ──────────────────────────────────
  const half = (INNER - 12) / 2;
  const boxH = 60;

  doc.roundedRect(MARGIN, y, half, boxH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('VEHÍCULO', MARGIN + 10, y + 8);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.dark).text(registro.vin || '—', MARGIN + 10, y + 22, { width: half - 20 });

  const cx = MARGIN + half + 12;
  doc.roundedRect(cx, y, half, boxH, 5).strokeColor(C.border).lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('ESTADO', cx + 10, y + 8);
  doc.roundedRect(cx + 10, y + 22, 110, 20, 10).fill(badge.color);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.white).text(badge.label, cx + 10, y + 28, { width: 110, align: 'center' });

  y += boxH + 14;

  // ── Detalle específico por tipo ─────────────────────────────────────
  if (tipo === 'revision') {
    const detalles = [
      ['Fecha realizada', fmtFecha(registro.fecha_realizada)],
      registro.kilometraje_registrado != null ? ['Kilometraje', `${Number(registro.kilometraje_registrado).toLocaleString('es-CO')} km`] : null,
      registro.valor_mano_obra != null ? ['Mano de obra', COP(registro.valor_mano_obra)] : null,
    ].filter(Boolean);

    doc.roundedRect(MARGIN, y, INNER, detalles.length * 18 + 16, 5).strokeColor(C.border).lineWidth(0.5).stroke();
    detalles.forEach(([lbl, val], i) => {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.gray).text(lbl, MARGIN + 10, y + 10 + i * 18);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text(val, MARGIN + INNER - 210, y + 10 + i * 18, { width: 200, align: 'right' });
    });
    y += detalles.length * 18 + 26;

    if (registro.observaciones) {
      const h = 46;
      doc.roundedRect(MARGIN, y, INNER, h, 4).strokeColor(C.border).lineWidth(0.4).stroke();
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('OBSERVACIONES', MARGIN + 10, y + 8);
      doc.font('Helvetica').fontSize(8.5).fillColor(C.dark).text(registro.observaciones, MARGIN + 10, y + 20, { width: INNER - 20, height: h - 26, ellipsis: true });
      y += h + 10;
    }

    const piezas = Array.isArray(registro.piezas) ? registro.piezas : [];
    if (piezas.length) {
      y = drawItemsTable(doc, y, MARGIN, INNER, 'PIEZAS USADAS', piezas.map(p => ({
        desc: p.pieza_codigo || 'N/D',
        cant: p.cantidad || 1,
      })));
    }
  } else {
    if (registro.fecha_cierre) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.gray).text('Fecha de cierre', MARGIN, y);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text(fmtFecha(registro.fecha_cierre), MARGIN + INNER - 200, y, { width: 200, align: 'right' });
      y += 20;
    }
    const items = Array.isArray(registro.items) ? registro.items : [];
    if (items.length) {
      const total = items.reduce((s, it) => s + (Number(it.costo_reconocido) || 0), 0);
      y = drawItemsTable(doc, y, MARGIN, INNER, 'ÍTEMS REPORTADOS', items.map(it => ({
        desc: `${it.pieza_codigo || 'N/D'}${it.codigo_falla ? ` — ${it.codigo_falla}` : ''}`,
        cant: it.cantidad || 1,
        valor: it.costo_reconocido,
      })));
      if (total > 0) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.primary).text(`Total reconocido: ${COP(total)}`, MARGIN, y, { width: INNER, align: 'right' });
        y += 20;
      }
    }
  }

  // ── Seguimiento en línea ────────────────────────────────────────────
  if (shareUrl && y < 680) {
    y += 10;
    doc.roundedRect(MARGIN, y, INNER, 40, 5).fill(C.soft);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text('Seguimiento en línea', MARGIN + 12, y + 8);
    doc.font('Helvetica').fontSize(8.5).fillColor(C.primary).text(shareUrl, MARGIN + 12, y + 21, { width: INNER - 24 });
  }

  doc.end();
}

function drawItemsTable(doc, y, MARGIN, INNER, titulo, filas) {
  if (y + 20 > 700) { doc.addPage(); y = 40; }
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text(titulo, MARGIN, y);
  y += 12;
  filas.forEach((f, i) => {
    if (y + 20 > 700) { doc.addPage(); y = 40; }
    if (i % 2 === 0) doc.rect(MARGIN, y, INNER, 20).fill(C.soft);
    doc.font('Helvetica').fontSize(8.5).fillColor(C.dark).text(f.desc, MARGIN + 8, y + 6, { width: INNER - 160 });
    doc.text(`× ${f.cant}`, MARGIN + INNER - 150, y + 6, { width: 60 });
    if (f.valor != null) {
      doc.font('Helvetica-Bold').text(COP(f.valor), MARGIN + INNER - 90, y + 6, { width: 82, align: 'right' });
    }
    y += 20;
  });
  return y + 10;
}

module.exports = { generarComprobantePDF };
