// backend/src/services/projects/actaPdfCommon.js
// Piezas compartidas por las actas PDF con firmas por rol (despacho de
// materiales y lote de herramientas).
const { signatureBuffer } = require('../../utils/signature');

const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' }) : '—');

/**
 * Dibuja una fila de firmas, una columna por rol.
 *  roles       [[role, label]] en el orden en que van en el acta
 *  signatures  [{ role, signed_name, signed_document, signature, signed_at }]
 * La firma es el PNG dibujado en pantalla; si falta, queda la línea y "Pendiente de firma".
 */
function drawSignatureBlocks(doc, { signatures, roles, y, left, width }) {
  const gray = '#6b7280';
  const black = '#111827';
  const sigW = width / roles.length;
  roles.forEach(([role, label], i) => {
    const sx = left + i * sigW;
    const s = signatures.find((x) => x.role === role);
    const buf = s ? signatureBuffer(s.signature) : null;
    if (buf) { try { doc.image(buf, sx + 8, y, { fit: [sigW - 24, 52], align: 'center' }); } catch { /* firma ilegible */ } }
    doc.moveTo(sx + 8, y + 56).lineTo(sx + sigW - 16, y + 56).lineWidth(0.6).strokeColor(gray).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(black).text(label, sx + 8, y + 60, { width: sigW - 24 });
    if (s) {
      doc.font('Helvetica').fontSize(8).fillColor(black).text(s.signed_name, sx + 8, doc.y, { width: sigW - 24 });
      if (s.signed_document) doc.fillColor(gray).text(`C.C./NIT ${s.signed_document}`, sx + 8, doc.y, { width: sigW - 24 });
      doc.fillColor(gray).fontSize(7).text(fmtDateTime(s.signed_at), sx + 8, doc.y, { width: sigW - 24 });
    } else {
      doc.font('Helvetica').fontSize(8).fillColor(gray).text('Pendiente de firma', sx + 8, doc.y, { width: sigW - 24 });
    }
  });
}

module.exports = { drawSignatureBlocks, fmtDateTime };
