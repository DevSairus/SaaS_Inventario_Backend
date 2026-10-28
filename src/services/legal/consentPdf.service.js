// backend/src/services/legal/consentPdf.service.js
//
// Constancia en PDF de una autorización (habeas data o acta de ingreso):
// datos del titular, evidencia de la aceptación (canal verificado, fecha,
// IP, versión y hash del documento), el texto completo aceptado y la
// bitácora. Es la "prueba de la autorización" que el titular puede pedir
// (Ley 1581 de 2012, art. 8 lit. b) y la que el taller conserva.

const PDFDocument = require('pdfkit');
const { drawHeader, createBufferStream, C } = require('../workshopPdfService');
const { customerDisplayName, maskEmail, maskPhone } = require('./consent.service');

const MARGIN = 40;

const fmtDateTime = (d) => (d
  ? new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' })
  : '—');

const STATUS_LABELS = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  rejected: 'Rechazada',
  revoked: 'Revocada',
  cancelled: 'Anulada',
  expired: 'Vencida',
};

const VIA_LABELS = {
  public_link: 'Electrónica — enlace abierto por el titular y confirmado con código de un solo uso',
  counter: 'Electrónica — en mostrador, confirmada con código de un solo uso enviado al titular',
  physical: 'Física — documento firmado registrado por el establecimiento',
};

const CHANNEL_LABELS = { email: 'Correo electrónico', whatsapp: 'WhatsApp' };

const EVENT_LABELS = {
  created: 'Solicitud creada',
  superseded: 'Reemplazada por una solicitud más reciente',
  intake_updated: 'Inventario de ingreso actualizado',
  link_sent: 'Enlace enviado al titular',
  otp_sent: 'Código de verificación enviado',
  otp_failed: 'Código incorrecto',
  accepted: 'Aceptada',
  rejected: 'Rechazada por el titular',
  revoked: 'Revocada',
  expired: 'Vencida',
  marketing_opt_out: 'Retiro de autorización de publicidad',
};

function ensureSpace(doc, y, needed) {
  if (y + needed > doc.page.height - 50) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

// Texto con segmentos **negrita** en una sola llamada encadenada.
function richText(doc, text, x, y, width, size) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  doc.fontSize(size).fillColor(C.dark);
  parts.forEach((part, i) => {
    const bold = part.startsWith('**') && part.endsWith('**');
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    const content = bold ? part.slice(2, -2) : part;
    const opts = { width, continued: i < parts.length - 1, lineGap: 1.5 };
    if (i === 0) doc.text(content, x, y, opts);
    else doc.text(content, opts);
  });
  return doc.y;
}

/**
 * Markdown básico (#, ##, ###, listas "- ", **negrita**) a pdfkit.
 */
function drawMarkdown(doc, markdown, startY) {
  const width = doc.page.width - MARGIN * 2;
  let y = startY;
  const blocks = String(markdown || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        const level = m[1].length;
        const size = level === 1 ? 12 : level === 2 ? 10 : 9;
        y = ensureSpace(doc, y, 30);
        doc.font('Helvetica-Bold').fontSize(size).fillColor(level === 1 ? C.primary : C.dark)
          .text(m[2].replace(/\*\*/g, ''), MARGIN, y + (level === 1 ? 0 : 4), { width });
        y = doc.y + 3;
      } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
        y = ensureSpace(doc, y, 14);
        doc.font('Helvetica').fontSize(8.5).fillColor(C.dark).text('•', MARGIN + 6, y);
        y = richText(doc, m[1], MARGIN + 16, y, width - 16, 8.5) + 1;
      } else {
        y = ensureSpace(doc, y, 14);
        y = richText(doc, line, MARGIN, y, width, 8.5) + 1;
      }
    }
    y += 4;
  }
  return y;
}

/**
 * Recuadro de evidencia de aceptación. Lo usa también el PDF de ingreso
 * (workshopPdfService.generateIntakeForm) en lugar de la línea de firma.
 */
function drawEvidenceBox(doc, consent, x, y, width) {
  const rows = [];
  if (consent.status === 'accepted' || consent.status === 'revoked') {
    rows.push(['Modalidad', VIA_LABELS[consent.accepted_via] || consent.accepted_via || '—']);
    rows.push(['Fecha y hora', fmtDateTime(consent.accepted_at)]);
    if (consent.verified_channel) {
      const dest = consent.verified_channel === 'email'
        ? maskEmail(consent.verified_destination)
        : maskPhone(consent.verified_destination);
      rows.push(['Verificado por', `${CHANNEL_LABELS[consent.verified_channel] || consent.verified_channel} ${dest || ''}`]);
    }
    if (consent.signer_name) rows.push(['Firmante', `${consent.signer_name}${consent.signer_document ? ` — ${consent.signer_document}` : ''}`]);
    if (consent.accepted_ip) rows.push(['Dirección IP', consent.accepted_ip]);
    if (consent.physical_notes) rows.push(['Notas', consent.physical_notes]);
    if (consent.physical_document) {
      rows.push(['Documento firmado', `${consent.physical_document.filename || 'Adjunto'} — SHA-256 ${consent.physical_document.sha256 || ''}`]);
    }
  }
  rows.push(['Estado', STATUS_LABELS[consent.status] || consent.status]);
  if (consent.kind === 'habeas_data' && consent.status === 'accepted') {
    rows.push(['Publicidad', consent.marketing_opt_in ? 'SÍ autoriza comunicaciones comerciales' : 'NO autoriza comunicaciones comerciales']);
  }
  if (consent.revoked_at) rows.push(['Revocada', `${fmtDateTime(consent.revoked_at)} — ${consent.revoke_reason || ''}`]);
  const version = consent.document_version;
  if (version) rows.push(['Documento', `Versión ${version.version} — SHA-256 ${version.content_hash}`]);
  if (consent.intake_hash) rows.push(['Inventario', `SHA-256 ${consent.intake_hash}`]);
  rows.push(['ID solicitud', consent.id]);

  const labelW = 78;
  const valueW = width - labelW - 20;
  doc.font('Helvetica').fontSize(7.5);
  const height = rows.reduce((h, [, v]) => h + Math.max(doc.heightOfString(String(v), { width: valueW }), 9) + 3, 0) + 22;

  doc.roundedRect(x, y, width, height, 5).fillAndStroke('#f0fdf4', '#86efac');
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.green).text('CONSTANCIA DE ACEPTACIÓN ELECTRÓNICA', x + 10, y + 7);
  let ry = y + 20;
  for (const [label, value] of rows) {
    doc.font('Helvetica').fontSize(7).fillColor(C.gray).text(label, x + 10, ry, { width: labelW });
    doc.font('Helvetica').fontSize(7.5).fillColor(C.dark).text(String(value), x + 10 + labelW, ry, { width: valueW });
    ry = Math.max(doc.y, ry + 9) + 3;
  }
  return y + height;
}

function drawIntakeSummary(doc, snapshot, y) {
  const width = doc.page.width - MARGIN * 2;
  y = ensureSpace(doc, y, 80);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(C.dark).text('Inventario de ingreso aceptado', MARGIN, y);
  y = doc.y + 4;
  const v = snapshot.vehicle || {};
  const lines = [
    ['Orden', snapshot.order_number],
    ['Vehículo', [v.plate, v.brand, v.model, v.year, v.color].filter(Boolean).join(' · ')],
    ['Km ingreso', snapshot.mileage_in != null ? `${Number(snapshot.mileage_in).toLocaleString('es-CO')} km` : '—'],
    ['Combustible', snapshot.fuel_label || '—'],
    ['Elementos', (snapshot.items || []).filter((i) => i.value !== 'unset')
      .map((i) => `${i.label}: ${i.value === 'ok' ? 'OK' : i.value === 'bad' ? 'Con novedad' : 'N/A'}`).join(' · ') || '—'],
    ['Observaciones', snapshot.observations || '—'],
    ['Objetos dejados', snapshot.belongings || '—'],
    ['Problema reportado', snapshot.problem_description || '—'],
    ['Fotos de ingreso', String((snapshot.photos || []).length)],
  ];
  for (const [label, value] of lines) {
    y = ensureSpace(doc, y, 14);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(label, MARGIN, y, { width: 95 });
    doc.font('Helvetica').fontSize(8).fillColor(C.dark).text(String(value || '—'), MARGIN + 100, y, { width: width - 100 });
    y = Math.max(doc.y, y + 10) + 3;
  }
  return y + 6;
}

async function generateConsentPdfBuffer({ consent, customer, tenant }) {
  const { stream, bufferPromise } = createBufferStream();
  const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
  doc.pipe(stream);

  const title = consent.kind === 'habeas_data' ? 'AUTORIZACIÓN DATOS' : 'ACTA DE INGRESO';
  const subtitle = consent.kind === 'habeas_data'
    ? 'Tratamiento de datos personales — Ley 1581 de 2012'
    : 'Autorización de ingreso del vehículo';
  let y = await drawHeader(doc, tenant, title, subtitle, consent.intake_snapshot?.order_number || null);

  const width = doc.page.width - MARGIN * 2;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(C.gray).text('TITULAR', MARGIN, y);
  y = doc.y + 2;
  const holder = [
    customerDisplayName(customer),
    customer?.tax_id ? `${customer.document_type || 'Doc.'} ${customer.tax_id}` : null,
    customer?.email,
    customer?.mobile || customer?.phone,
  ].filter(Boolean).join('  ·  ');
  doc.font('Helvetica').fontSize(9).fillColor(C.dark).text(holder || '—', MARGIN, y, { width });
  y = doc.y + 10;

  y = drawEvidenceBox(doc, consent, MARGIN, y, width) + 14;

  if (consent.kind === 'vehicle_intake' && consent.intake_snapshot) {
    y = drawIntakeSummary(doc, consent.intake_snapshot, y);
  }

  y = ensureSpace(doc, y, 40);
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).strokeColor(C.border).lineWidth(0.5).stroke();
  y = drawMarkdown(doc, consent.document_version?.content || '', y + 10);

  const events = consent.events || [];
  if (events.length) {
    y = ensureSpace(doc, y + 6, 40);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.dark).text('Bitácora', MARGIN, y);
    y = doc.y + 4;
    for (const e of events) {
      y = ensureSpace(doc, y, 12);
      const detail = [
        e.channel && (CHANNEL_LABELS[e.channel] || e.channel),
        e.destination,
        e.via && e.type !== 'otp_sent' ? e.via : null,
        e.ip,
        e.reason,
      ].filter(Boolean).join(' · ');
      doc.font('Helvetica').fontSize(7).fillColor(C.gray)
        .text(`${fmtDateTime(e.at)}  —  ${EVENT_LABELS[e.type] || e.type}${detail ? `  (${detail})` : ''}`, MARGIN, y, { width });
      y = doc.y + 2;
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Sin esto, escribir bajo el margen inferior hace que pdfkit abra una
    // página en blanco nueva.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(6.5).fillColor(C.lightGray)
      .text(`Página ${i + 1} de ${range.count} · Generado ${fmtDateTime(new Date())}`, MARGIN, doc.page.height - 30, {
        width, align: 'right', lineBreak: false,
      });
  }

  doc.end();
  return bufferPromise;
}

module.exports = { generateConsentPdfBuffer, drawEvidenceBox, drawMarkdown };
