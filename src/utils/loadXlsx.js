// backend/src/utils/loadXlsx.js
//
// Carga un .xlsx con ExcelJS tolerando archivos guardados por otras
// herramientas (openpyxl, Google Sheets, generadores web...). ExcelJS 4.x
// falla con "Cannot read properties of undefined (reading 'comments')"
// cuando las notas de celda vienen en rutas que no espera (p. ej. openpyxl
// las deja en /xl/comments/comment1.xml con destino absoluto). Las
// importaciones nunca leen notas ni dibujos: si la carga falla, se quitan
// del paquete y se reintenta.
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');

const DROP_REL_TYPES = /\/(comments|vmlDrawing|drawing|threadedComment|person)"/;

function stripCommentsAndDrawings(buffer) {
  const zip = new AdmZip(buffer);
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(name)) {
      const xml = entry.getData().toString('utf8');
      const cleaned = xml.replace(/<Relationship\b[^>]*\/>/g, (rel) => (DROP_REL_TYPES.test(rel) ? '' : rel));
      if (cleaned !== xml) zip.updateFile(entry, Buffer.from(cleaned, 'utf8'));
    } else if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      const xml = entry.getData().toString('utf8');
      const cleaned = xml.replace(/<(legacyDrawing|drawing|legacyDrawingHF)\b[^>]*\/>/g, '');
      if (cleaned !== xml) zip.updateFile(entry, Buffer.from(cleaned, 'utf8'));
    }
  }
  return zip.toBuffer();
}

/**
 * @param {Buffer} buffer contenido del .xlsx
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function loadXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
    return wb;
  } catch (err) {
    let cleaned;
    try {
      cleaned = stripCommentsAndDrawings(buffer);
    } catch {
      throw err; // no es un zip: el error original es el que sirve
    }
    const retry = new ExcelJS.Workbook();
    await retry.xlsx.load(cleaned);
    return retry;
  }
}

module.exports = { loadXlsx, stripCommentsAndDrawings };
