// Helpers compartidos para leer celdas de ExcelJS de forma tolerante.
// Extraído de productsBulkImport.controller.js para reutilizarlo también en
// physicalCounts.controller.js (plantilla/carga de conteo físico).

// ExcelJS puede devolver fórmulas/rich text en vez de un string plano.
function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  }
  return String(value);
}

// Parseo tolerante de números en formato es-CO (coma decimal, puntos de miles,
// texto con espacios). Devuelve NaN si no se puede interpretar como número.
// Ej: "1.234,56" -> 1234.56 · "1234,56" -> 1234.56 · "1234.56" -> 1234.56
function parseLocaleNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  let text = cellToText(value).trim();
  if (text === '') return NaN;

  // Si tiene coma Y punto, asumimos que el punto es separador de miles y la
  // coma es el decimal (es-CO). Si solo tiene coma, la coma es el decimal.
  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (hasComma && hasDot) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    text = text.replace(',', '.');
  }
  // Quitar cualquier caracter que no sea dígito, signo o punto decimal.
  text = text.replace(/[^0-9.\-]/g, '');
  if (text === '' || text === '-') return NaN;
  return parseFloat(text);
}

module.exports = { cellToText, parseLocaleNumber };
