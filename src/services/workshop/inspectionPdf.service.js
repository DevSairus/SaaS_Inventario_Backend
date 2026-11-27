// backend/src/services/workshop/inspectionPdf.service.js
//
// Certificado de peritaje en PDF (pdfkit). Misma cabecera que los PDF del
// taller. Lleva un QR al enlace público de verificación
// (/peritaje/:verify_token) para que quien reciba el papel compruebe que el
// peritaje existe, no fue anulado y dice lo mismo.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { drawHeader, createBufferStream, downloadImage, C } = require('../workshopPdfService');
const { BODY_ZONES, bodyKindFor, REPAINT_MICRONS } = require('../../constants/inspectionTemplates');
const { signatureBuffer } = require('../../utils/signature');

const MARGIN = 40;
const CONCEPT = {
  aprobado: { label: 'APROBADO', color: C.green },
  aprobado_observaciones: { label: 'APROBADO CON OBSERVACIONES', color: C.orange },
  no_recomendado: { label: 'NO RECOMENDADO', color: C.red },
};
const RATING = {
  bueno: { label: 'Bueno', color: C.green },
  regular: { label: 'Regular', color: C.orange },
  malo: { label: 'Malo', color: C.red },
  na: { label: 'N/A', color: C.lightGray },
};
const REQUESTER = { propietario: 'Propietario', comprador: 'Comprador', financiera: 'Entidad financiera', aseguradora: 'Aseguradora', concesionario: 'Concesionario', otro: 'Otro' };
const PURPOSE = { compraventa: 'Compraventa', financiacion: 'Financiación', seguro: 'Seguro', control: 'Control / revisión', otro: 'Otro' };
const DAMAGE = { golpe: 'Golpe', rayon: 'Rayón', repintura: 'Repintura', masilla: 'Masilla', cambio_pieza: 'Pieza cambiada', corrosion: 'Corrosión', vidrio: 'Vidrio', otro: 'Otro' };
const VEHICLE_TYPE = { automovil: 'Automóvil', camioneta: 'Camioneta', motocicleta: 'Motocicleta', motocarro: 'Motocarro', cuatrimoto: 'Cuatrimoto', utv: 'UTV', camion: 'Camión', otro: 'Otro' };

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }) : '—');
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-CO'));
const triLabel = (v) => (v === true ? 'Coincide' : v === false ? 'NO coincide' : 'Sin verificar');

async function imageForPdf(url) {
  try {
    const buf = await downloadImage(url);
    return await sharp(buf).rotate().resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  } catch {
    return null;
  }
}

function ensureSpace(doc, y, needed) {
  if (y + needed > doc.page.height - 60) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

function sectionTitle(doc, text, y) {
  y = ensureSpace(doc, y, 40);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.primary).text(text.toUpperCase(), MARGIN, y);
  doc.moveTo(MARGIN, y + 14).lineTo(doc.page.width - MARGIN, y + 14).strokeColor(C.border).lineWidth(0.7).stroke();
  return y + 20;
}

/** Pares etiqueta/valor en dos columnas. */
function keyValues(doc, pairs, y) {
  const inner = doc.page.width - MARGIN * 2;
  const colW = inner / 2;
  let rowY = y;
  pairs.forEach(([k, v], i) => {
    const x = MARGIN + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) rowY += 15;
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(k, x, rowY, { width: 95 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text(v === null || v === undefined || v === '' ? '—' : String(v), x + 95, rowY, { width: colW - 100, ellipsis: true, lineBreak: false });
  });
  return rowY + 20;
}

async function generateInspectionPdfBuffer({ inspection, tenant, verifyUrl }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true, info: { Title: `Peritaje ${inspection.number}` } });
  const { stream, bufferPromise } = createBufferStream();
  doc.pipe(stream);
  const W = doc.page.width;
  const inner = W - MARGIN * 2;
  const v = inspection.vehicle || {};
  const unit = inspection.meter_unit === 'h' ? 'h' : 'km';

  let y = await drawHeader(doc, tenant || {}, 'CERTIFICADO DE PERITAJE', fmtDate(inspection.inspected_at), inspection.number);

  if (inspection.status === 'cancelled') {
    doc.save().rotate(-30, { origin: [W / 2, 400] }).font('Helvetica-Bold').fontSize(70).fillColor(C.red).opacity(0.15)
      .text('ANULADO', 0, 380, { width: W, align: 'center' }).restore().opacity(1);
  } else if (inspection.status === 'draft') {
    doc.save().rotate(-30, { origin: [W / 2, 400] }).font('Helvetica-Bold').fontSize(70).fillColor(C.gray).opacity(0.12)
      .text('BORRADOR', 0, 380, { width: W, align: 'center' }).restore().opacity(1);
  }

  // ── Resultado ──
  const concept = CONCEPT[inspection.concept || inspection.suggested_concept] || { label: 'SIN CONCEPTO', color: C.gray };
  doc.roundedRect(MARGIN, y, inner, 58, 6).fill(concept.color);
  doc.font('Helvetica').fontSize(8).fillColor(C.white).text('CONCEPTO', MARGIN + 14, y + 10);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(C.white).text(concept.label, MARGIN + 14, y + 24, { width: inner - 140 });
  doc.font('Helvetica').fontSize(8).fillColor(C.white).text('PUNTAJE', MARGIN + inner - 120, y + 10, { width: 106, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(24).fillColor(C.white)
    .text(inspection.score != null ? fmtNum(inspection.score) : '—', MARGIN + inner - 120, y + 20, { width: 80, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(C.white).text('/ 100', MARGIN + inner - 38, y + 33);
  y += 72;

  // ── Vehículo ──
  y = sectionTitle(doc, 'Vehículo', y);
  y = keyValues(doc, [
    ['Placa', v.plate], ['Tipo', VEHICLE_TYPE[v.vehicle_type] || v.vehicle_type],
    ['Marca', v.brand], ['Línea', v.model],
    ['Modelo (año)', v.year], ['Color', v.color],
    ['VIN / chasis', v.vin], ['N° motor', v.engine_number],
    ['Cilindraje', v.engine], [unit === 'h' ? 'Horómetro' : 'Kilometraje', inspection.mileage != null ? `${fmtNum(inspection.mileage)} ${unit}` : '—'],
  ], y);

  // ── Solicitud ──
  y = sectionTitle(doc, 'Solicitud', y);
  y = keyValues(doc, [
    ['Solicitante', inspection.requester_name], ['Documento', inspection.requester_document],
    ['Calidad', REQUESTER[inspection.requester_type]], ['Propósito', PURPOSE[inspection.purpose]],
    ['Perito', inspection.inspector ? `${inspection.inspector.first_name || ''} ${inspection.inspector.last_name || ''}`.trim() : '—'],
    ['Plantilla', inspection.template_name],
  ], y);

  // ── Identificación e improntas ──
  const id = inspection.identity || {};
  y = sectionTitle(doc, 'Identificación e improntas', y);
  y = keyValues(doc, [
    ['VIN registrado', id.vin_expected], ['VIN leído', id.vin_read],
    ['Verificación VIN', triLabel(id.vin_match)], ['Verificación chasis', triLabel(id.chassis_match)],
    ['Motor registrado', id.engine_expected], ['Motor leído', id.engine_read],
    ['Verificación motor', triLabel(id.engine_match)], ['Verificación placa', triLabel(id.plate_match)],
  ], y);
  if (id.notes) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.gray).text(id.notes, MARGIN, y - 4, { width: inner });
    y = doc.y + 8;
  }

  // ── RUNT ──
  const runt = inspection.runt_snapshot;
  if (runt) {
    y = sectionTitle(doc, 'Consulta RUNT', y);
    const yn = (b) => (b === true ? 'SÍ REPORTA' : b === false ? 'No reporta' : '—');
    y = keyValues(doc, [
      ['Fecha consulta', fmtDate(runt.consulted_at)], ['Estado', runt.estado],
      ['Prendas', yn(runt.has_pledges)], ['Gravámenes', yn(runt.has_liens)],
      ['SOAT vence', runt.soat_expiry || '—'], ['Técnico-mecánica vence', runt.tecnomecanica_expiry || '—'],
    ], y);
  }

  // ── Puntaje por sistema ──
  const sections = (inspection.section_scores || []).filter((s) => s.score !== null);
  if (sections.length) {
    y = sectionTitle(doc, 'Resultado por sistema', y);
    for (const s of sections) {
      y = ensureSpace(doc, y, 18);
      const color = s.score >= 80 ? C.green : s.score >= 60 ? C.orange : C.red;
      doc.font('Helvetica').fontSize(8).fillColor(C.dark).text(s.label, MARGIN, y + 2, { width: 160 });
      const barX = MARGIN + 165;
      const barW = inner - 165 - 45;
      doc.roundedRect(barX, y + 2, barW, 8, 3).fill(C.border);
      doc.roundedRect(barX, y + 2, Math.max(4, (barW * s.score) / 100), 8, 3).fill(color);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(color).text(fmtNum(s.score), barX + barW + 6, y + 1, { width: 38, align: 'right' });
      y += 15;
    }
    y += 6;
  }

  // ── Detalle ──
  const items = inspection.items || [];
  const sectionsMeta = inspection.template_snapshot || [];
  y = sectionTitle(doc, 'Detalle de la inspección', y);
  for (const sec of sectionsMeta) {
    const secItems = items.filter((it) => it.section_key === sec.key);
    if (!secItems.length) continue;
    y = ensureSpace(doc, y, 34);
    doc.rect(MARGIN, y, inner, 15).fill(C.soft);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text(sec.label, MARGIN + 6, y + 4);
    y += 18;
    for (const it of secItems) {
      const notes = it.notes || '';
      const h = Math.max(13, notes ? doc.font('Helvetica').fontSize(7).heightOfString(notes, { width: inner - 330 }) + 4 : 13);
      y = ensureSpace(doc, y, h);
      const r = RATING[it.rating] || { label: '—', color: C.lightGray };
      doc.font('Helvetica').fontSize(8).fillColor(C.dark).text(`${it.label}${it.critical ? ' *' : ''}`, MARGIN + 6, y + 1, { width: 200 });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(r.color).text(r.label, MARGIN + 210, y + 1, { width: 55 });
      if (it.measure !== null && it.measure !== undefined) {
        doc.font('Helvetica').fontSize(8).fillColor(C.dark).text(`${fmtNum(it.measure)} ${it.unit || ''}`, MARGIN + 265, y + 1, { width: 60 });
      }
      if (notes) doc.font('Helvetica').fontSize(7).fillColor(C.gray).text(notes, MARGIN + 330, y + 1, { width: inner - 330 });
      doc.moveTo(MARGIN, y + h).lineTo(MARGIN + inner, y + h).strokeColor(C.border).lineWidth(0.3).stroke();
      y += h + 2;
    }
    y += 4;
  }
  doc.font('Helvetica-Oblique').fontSize(7).fillColor(C.gray).text('* Punto crítico: si se califica como malo, el concepto es "No recomendado".', MARGIN, y);
  y += 14;

  // ── Carrocería ──
  const zones = Object.fromEntries(BODY_ZONES[bodyKindFor(v.vehicle_type)].map(([k, l]) => [k, l]));
  const marks = inspection.body_marks || [];
  const paint = inspection.paint_readings || {};
  if (marks.length || Object.keys(paint).length) {
    y = sectionTitle(doc, 'Carrocería y pintura', y);
    for (const mk of marks) {
      y = ensureSpace(doc, y, 13);
      const col = mk.severity === 'grave' ? C.red : mk.severity === 'moderado' ? C.orange : C.dark;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(col).text(`${zones[mk.zone] || mk.zone}: ${DAMAGE[mk.damage] || mk.damage} (${mk.severity})`, MARGIN + 6, y, { width: 230 });
      if (mk.notes) doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(mk.notes, MARGIN + 240, y, { width: inner - 240 });
      y = Math.max(y + 12, doc.y + 2);
    }
    const readings = Object.entries(paint);
    if (readings.length) {
      y = ensureSpace(doc, y, 30);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark).text('Espesor de pintura (micras)', MARGIN + 6, y + 4);
      y += 16;
      const colW = inner / 4;
      readings.forEach(([zone, mic], i) => {
        if (i % 4 === 0 && i > 0) y += 12;
        y = ensureSpace(doc, y, 12);
        const over = mic > REPAINT_MICRONS;
        doc.font(over ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(over ? C.orange : C.dark)
          .text(`${zones[zone] || zone}: ${mic} µm`, MARGIN + 6 + (i % 4) * colW, y, { width: colW - 6 });
      });
      y += 16;
      doc.font('Helvetica-Oblique').fontSize(7).fillColor(C.gray).text(`Lecturas por encima de ${REPAINT_MICRONS} µm sugieren repintura.`, MARGIN + 6, y);
      y += 14;
    }
  }

  // ── Conclusión ──
  if (inspection.conclusion || inspection.recommendations) {
    y = sectionTitle(doc, 'Conclusión', y);
    if (inspection.conclusion) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.dark).text(inspection.conclusion, MARGIN, y, { width: inner });
      y = doc.y + 8;
    }
    if (inspection.recommendations) {
      y = ensureSpace(doc, y, 30);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.dark).text('Recomendaciones', MARGIN, y);
      doc.font('Helvetica').fontSize(8.5).fillColor(C.dark).text(inspection.recommendations, MARGIN, y + 12, { width: inner });
      y = doc.y + 8;
    }
  }

  // ── Fotos ──
  const photos = [
    ...(inspection.photos || []).map((p) => ({ url: p.url, caption: p.caption })),
    ...items.flatMap((it) => (it.photos || []).map((p) => ({ url: p.url, caption: it.label }))),
  ].slice(0, 12);
  if (photos.length) {
    y = sectionTitle(doc, 'Registro fotográfico', y);
    const cols = 3;
    const gap = 8;
    const pw = (inner - gap * (cols - 1)) / cols;
    const ph = pw * 0.72;
    let col = 0;
    for (const p of photos) {
      if (col === 0) y = ensureSpace(doc, y, ph + 16);
      const img = await imageForPdf(p.url);
      const x = MARGIN + col * (pw + gap);
      if (img) {
        try { doc.image(img, x, y, { fit: [pw, ph], align: 'center', valign: 'center' }); } catch { /* imagen dañada */ }
      }
      doc.rect(x, y, pw, ph).strokeColor(C.border).lineWidth(0.5).stroke();
      if (p.caption) doc.font('Helvetica').fontSize(6.5).fillColor(C.gray).text(p.caption, x, y + ph + 2, { width: pw, ellipsis: true, lineBreak: false });
      col += 1;
      if (col === cols) { col = 0; y += ph + 14; }
    }
    if (col !== 0) y += ph + 14;
  }

  // ── Firma + verificación ──
  y = ensureSpace(doc, y, 120);
  y += 10;
  const sig = inspection.inspector_signature ? signatureBuffer(inspection.inspector_signature) : null;
  if (sig) {
    try { doc.image(sig, MARGIN, y, { fit: [170, 60] }); } catch { /* firma dañada */ }
  }
  doc.moveTo(MARGIN, y + 64).lineTo(MARGIN + 190, y + 64).strokeColor(C.dark).lineWidth(0.6).stroke();
  doc.font('Helvetica-Bold').fontSize(8).fillColor(C.dark)
    .text(inspection.inspector ? `${inspection.inspector.first_name || ''} ${inspection.inspector.last_name || ''}`.trim() : 'Perito', MARGIN, y + 68, { width: 190 });
  doc.font('Helvetica').fontSize(7).fillColor(C.gray).text('Perito responsable', MARGIN, y + 79);

  if (verifyUrl && inspection.status !== 'draft') {
    const qr = await QRCode.toBuffer(verifyUrl, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    const qx = MARGIN + inner - 90;
    doc.image(qr, qx, y, { width: 84 });
    doc.font('Helvetica').fontSize(6.5).fillColor(C.gray)
      .text('Verifica este certificado escaneando el código', qx - 130, y + 20, { width: 122, align: 'right' });
  }
  y += 100;

  doc.font('Helvetica').fontSize(6.5).fillColor(C.lightGray).text(
    'Este peritaje refleja el estado del vehículo en la fecha y el kilometraje indicados, según la inspección visual y funcional realizada sin desarmar componentes. '
    + 'No constituye garantía sobre el comportamiento futuro del vehículo ni reemplaza la consulta oficial del RUNT.',
    MARGIN, ensureSpace(doc, y, 30), { width: inner, align: 'justify' },
  );

  // Pie con paginación
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Sin margen inferior: escribir por debajo de él haría que pdfkit agregue una hoja.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(C.lightGray)
      .text(`${inspection.number} · Página ${i + 1} de ${range.count}`, MARGIN, doc.page.height - 30, { width: inner, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return bufferPromise;
}

module.exports = { generateInspectionPdfBuffer };
