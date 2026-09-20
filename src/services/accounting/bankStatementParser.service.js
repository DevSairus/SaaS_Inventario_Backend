// backend/src/services/accounting/bankStatementParser.service.js
//
// Conciliación Bancaria — Fase 3 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3.
//
// Lee el archivo del extracto (Excel vía `exceljs`, o CSV/TXT delimitado
// parseado a mano) y lo reduce a { headers, rows } genérico, sin conocer
// todavía a qué campo (fecha/valor/descripción/...) corresponde cada
// columna -- eso lo resuelve `column_mapping` (elegido por el usuario o
// recordado en un BankImportTemplate) en `buildTransactionsFromRows`.
//
// Nota (igual que dice el plan): no hay `papaparse` instalado y no vale la
// pena agregar una dependencia nueva solo para parsear CSV/TXT delimitado
// simple -- se detecta el delimitador probando los candidatos más comunes
// sobre la primera línea. Ancho fijo real (columnas por posición de
// caracter) queda fuera de alcance salvo que aparezca un caso real.
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const DELIMITER_CANDIDATES = [';', ',', '\t', '|'];

/** Detecta el delimitador probando los candidatos más comunes sobre la primera línea. */
function detectDelimiter(firstLine) {
  let best = ';';
  let bestCount = -1;
  for (const d of DELIMITER_CANDIDATES) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

// Parser CSV/TXT simple: respeta campos entre comillas dobles (incluyendo
// el delimitador o saltos de línea dentro de las comillas), suficiente para
// extractos bancarios reales sin necesitar una librería completa de CSV.
function splitDelimitedLine(line, delimiter) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function parseDelimitedText(text) {
  // Normaliza saltos de línea y descarta líneas totalmente vacías (comunes
  // al final del archivo).
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitDelimitedLine(lines[0], delimiter);

  const rows = lines.slice(1).map((line) => {
    const values = splitDelimitedLine(line, delimiter);
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] !== undefined ? values[idx] : ''; });
    return row;
  });

  return { headers, rows };
}

// ExcelJS puede devolver fórmulas/rich text en vez de un string plano, y
// fechas ya como objeto Date -- se preserva el Date tal cual (parseDateValue
// lo detecta) y todo lo demás se vuelve texto.
function cellToValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
  }
  return value;
}

async function parseExcelBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cellToValue(cell.value) || '').trim();
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      const value = cellToValue(cell.value);
      if (value !== '' && value !== null && value !== undefined) hasValue = true;
      data[key] = value;
    });
    if (hasValue) rows.push(data);
  });

  return { headers: headers.filter(Boolean), rows };
}

/**
 * Lee el archivo del extracto y lo reduce a { headers, rows }.
 * @param {Buffer} buffer
 * @param {string} originalName - para decidir Excel vs texto delimitado por extensión
 */
async function parseStatementFile(buffer, originalName) {
  const ext = (originalName || '').toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xls') {
    return parseExcelBuffer(buffer);
  }
  // CSV/TXT: se asume UTF-8; si el banco exporta en otra codificación se
  // revisa como caso puntual cuando aparezca.
  return parseDelimitedText(buffer.toString('utf8'));
}

/**
 * Hash estable de los headers detectados -- así se reconoce "ya vi este
 * layout antes" para aplicar automáticamente el BankImportTemplate guardado.
 */
function computeFileSignature(headers) {
  const normalized = headers.map((h) => String(h).trim().toLowerCase()).join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Primeras N filas ya parseadas, para la vista previa del frontend. */
function previewRows(rows, n = 3) {
  return rows.slice(0, n);
}

// --- Parseo de valores individuales (fecha / monto) según el mapeo elegido ---

const MONTHS_ES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };

/** Convierte un valor de fecha (string en date_format, o Date de Excel) a 'YYYY-MM-DD'. */
function parseDateValue(raw, dateFormat) {
  if (raw instanceof Date && !isNaN(raw)) {
    return raw.toISOString().slice(0, 10);
  }
  const text = String(raw || '').trim();
  if (!text) return null;

  // ISO directo (algunos bancos ya exportan así, sin importar el date_format elegido).
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  const parts = text.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3) return null;

  const order = (dateFormat || 'DD/MM/YYYY').toUpperCase().split(/[/\-.]/);
  const map = {};
  order.forEach((token, idx) => { map[token] = parts[idx]; });

  let { DD: day, MM: month, YYYY: year } = map;
  if (!day || !month || !year) return null;
  if (year.length === 2) year = `20${year}`;
  if (isNaN(Number(month)) && MONTHS_ES[month.toLowerCase().slice(0, 3)]) {
    month = String(MONTHS_ES[month.toLowerCase().slice(0, 3)]);
  }

  day = String(day).padStart(2, '0');
  month = String(month).padStart(2, '0');
  if (day.length !== 2 || month.length !== 2 || year.length !== 4) return null;
  return `${year}-${month}-${day}`;
}

/** Convierte un valor de monto (string con separador decimal ',' o '.') a número. Devuelve NaN si no es válido. */
function parseAmountValue(raw, decimalSeparator = ',') {
  if (typeof raw === 'number') return raw;
  let text = String(raw ?? '').trim();
  if (!text) return NaN;
  // Quita símbolos de moneda / espacios comunes en extractos ($, COP, etc.)
  text = text.replace(/[^0-9,.\-()]/g, '');
  // Paréntesis = negativo (formato contable), algunos bancos lo usan para salidas.
  const isParenNegative = /^\(.*\)$/.test(text);
  if (isParenNegative) text = text.slice(1, -1);

  if (decimalSeparator === ',') {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }

  const value = parseFloat(text);
  if (isNaN(value)) return NaN;
  return isParenNegative ? -Math.abs(value) : value;
}

/**
 * Aplica `column_mapping` + `amount_format` + `date_format` a las filas
 * genéricas ya leídas del archivo, devolviendo los movimientos listos para
 * `BankTransaction.bulkCreate` + las filas que no calzaron (se reportan al
 * usuario en vez de fallar todo el import, como pide el plan).
 *
 * @param {Array<object>} rows
 * @param {object} columnMapping - { fecha, descripcion, referencia, modo, valor, debito, credito }
 * @param {object} amountFormat - { decimal_separator }
 * @param {string} dateFormat
 */
function buildTransactionsFromRows(rows, columnMapping, amountFormat, dateFormat) {
  const decimalSeparator = amountFormat?.decimal_separator || ',';
  const modo = columnMapping?.modo || 'unico';

  const transactions = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // +1 por índice 0-based, +1 por la fila de headers
    const dateRaw = row[columnMapping.fecha];
    const date = parseDateValue(dateRaw, dateFormat);
    if (!date) {
      errors.push({ row: rowNumber, error: `Fecha no reconocida: "${dateRaw}"` });
      return;
    }

    let amount;
    if (modo === 'debito_credito') {
      const debit = parseAmountValue(row[columnMapping.debito], decimalSeparator);
      const credit = parseAmountValue(row[columnMapping.credito], decimalSeparator);
      const hasDebit = !isNaN(debit) && debit !== 0;
      const hasCredit = !isNaN(credit) && credit !== 0;
      if (hasDebit && hasCredit) {
        errors.push({ row: rowNumber, error: 'La fila tiene valor en débito Y crédito a la vez' });
        return;
      }
      amount = hasDebit ? Math.abs(debit) : hasCredit ? -Math.abs(credit) : 0;
      if (!hasDebit && !hasCredit) {
        errors.push({ row: rowNumber, error: 'Sin monto en débito ni en crédito' });
        return;
      }
    } else {
      amount = parseAmountValue(row[columnMapping.valor], decimalSeparator);
      if (isNaN(amount)) {
        errors.push({ row: rowNumber, error: `Monto no reconocido: "${row[columnMapping.valor]}"` });
        return;
      }
    }

    transactions.push({
      transaction_date: date,
      description: columnMapping.descripcion ? String(row[columnMapping.descripcion] ?? '').trim().slice(0, 255) || null : null,
      amount,
      reference: columnMapping.referencia ? String(row[columnMapping.referencia] ?? '').trim().slice(0, 100) || null : null,
      raw_row: row,
    });
  });

  return { transactions, errors };
}

module.exports = {
  parseStatementFile,
  computeFileSignature,
  previewRows,
  parseDateValue,
  parseAmountValue,
  buildTransactionsFromRows,
};
