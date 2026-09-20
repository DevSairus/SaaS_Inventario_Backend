// backend/src/services/exogena/muiscaXmlBuilder.js
//
// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
//
// Constructor genérico del archivo XML "muisca" que exigen TODOS los
// anexos técnicos de Exógena revisados (1001, 1003, 1004, 1005, 1006, 1007,
// 2276 — Resolución 000227 de 23-09-2025, anexos T3.17-T3.45): mismo
// esqueleto Encabezado (elemento "Cab") + N registros de contenido, mismo
// estándar de nombre de archivo, mismo límite de 5000 registros por archivo.
// Los formatXXXX.service.js solo arman el array de registros (atributos ya
// resueltos) y describen cómo se llama el elemento de contenido — todo lo
// demás (Cab, chunking, nombre de archivo, escape XML) vive aquí una sola
// vez.

const ISO_8859_1_DECLARATION = '<?xml version="1.0" encoding="ISO-8859-1"?>';
const MAX_RECORDS_PER_FILE = 5000;

function escapeXmlAttr(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pad(num, length) {
  return String(num).padStart(length, '0');
}

// AAAA-MM-DDTHH:MM:SS, sin milisegundos ni zona -- formato exigido
// literalmente por todos los anexos técnicos revisados.
function formatDateTime(date) {
  return date.toISOString().slice(0, 19);
}

function formatDate(dateStr) {
  // dateStr ya viene 'YYYY-MM-DD' (DATEONLY) o Date -- normaliza a 10 chars.
  if (dateStr instanceof Date) return dateStr.toISOString().slice(0, 10);
  return String(dateStr).slice(0, 10);
}

function attrsToString(record) {
  return Object.entries(record)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`)
    .join(' ');
}

function buildCabXml({ formatCode, version, year, sendNumber, cantReg, valorTotal, fecInicial, fecFinal }) {
  return (
    '<Cab>' +
    `<Ano>${year}</Ano>` +
    '<CodCpt>1</CodCpt>' + // 1 = inserción. Reemplazo (2) queda para cuando exista flujo de corrección.
    `<Formato>${formatCode}</Formato>` +
    `<Version>${version}</Version>` +
    `<NumEnvio>${pad(sendNumber, 8)}</NumEnvio>` +
    `<FecEnvio>${formatDateTime(new Date())}</FecEnvio>` +
    `<FecInicial>${formatDate(fecInicial)}</FecInicial>` +
    `<FecFinal>${formatDate(fecFinal)}</FecFinal>` +
    `<ValorTotal>${Math.round(valorTotal)}</ValorTotal>` +
    `<CantReg>${cantReg}</CantReg>` +
    '</Cab>'
  );
}

/**
 * @param {object} opts
 * @param {string} opts.formatCode - '1001', '1007', '2276', etc. (sin ceros a la izquierda para <Formato>).
 * @param {number} opts.version - versión del anexo técnico (10, 7, 8, 9, 4...).
 * @param {string} opts.recordElementName - nombre del elemento de contenido ('pagos', 'rets', 'ingresos', 'rentra', etc.).
 * @param {Array<object>} opts.records - registros ya resueltos (atributos → valor). Se ignoran claves con valor null/undefined/''.
 * @param {string} opts.totalValueField - atributo cuya sumatoria va en <ValorTotal> (cada anexo define cuál).
 * @param {number} opts.year - año gravable.
 * @param {string|Date} opts.fecInicial - inicio del período reportado (YYYY-MM-DD).
 * @param {string|Date} opts.fecFinal - fin del período reportado (YYYY-MM-DD).
 * @param {number} [opts.startingSendNumber] - consecutivo de envío inicial (si se generan varios archivos por el límite de 5000 registros, se incrementa por archivo).
 * @returns {Array<{filename: string, content: string, recordCount: number}>}
 */
function buildMuiscaFiles(opts) {
  const {
    formatCode, version, recordElementName, records, totalValueField,
    year, fecInicial, fecFinal, startingSendNumber = 1,
  } = opts;

  const formatPadded = pad(formatCode, 5);
  const versionPadded = pad(version, 2);

  const chunks = [];
  for (let i = 0; i < records.length; i += MAX_RECORDS_PER_FILE) {
    chunks.push(records.slice(i, i + MAX_RECORDS_PER_FILE));
  }
  // Si no hay registros, igual se genera un archivo vacío (Cab con
  // CantReg=0) -- deja evidencia de que el formato se corrió para el año,
  // en vez de fallar en silencio.
  if (chunks.length === 0) chunks.push([]);

  return chunks.map((chunk, idx) => {
    const sendNumber = startingSendNumber + idx;
    const valorTotal = chunk.reduce((sum, r) => sum + Number(r[totalValueField] || 0), 0);
    const cab = buildCabXml({
      formatCode, version, year, sendNumber, cantReg: chunk.length, valorTotal, fecInicial, fecFinal,
    });
    const recordsXml = chunk.map((r) => `<${recordElementName} ${attrsToString(r)}/>`).join('');
    const content = `${ISO_8859_1_DECLARATION}\n<mas>${cab}${recordsXml}</mas>`;
    const filename = `Dmuisca_01${formatPadded}${versionPadded}${year}${pad(sendNumber, 8)}.xml`;
    return { filename, content, recordCount: chunk.length };
  });
}

module.exports = { buildMuiscaFiles, escapeXmlAttr, MAX_RECORDS_PER_FILE };
