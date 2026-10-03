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
const { readXlsxRows, excelSerialToISO } = require('../../utils/xlsxLite');

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

// Texto delimitado → matriz de valores (sin asumir dónde está el encabezado).
function parseDelimitedMatrix(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return [];
  // El delimitador se detecta sobre la línea con más candidatos (la primera
  // puede ser un título del banco sin delimitadores).
  const sample = nonEmpty.slice(0, 30).reduce((a, b) => (b.length > a.length ? b : a), '');
  const delimiter = detectDelimiter(sample);
  return lines.map((line) => (line.trim() ? splitDelimitedLine(line, delimiter) : []));
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

async function parseExcelMatrix(buffer) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const matrix = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => { cells[colNumber - 1] = cellToValue(cell.value); });
      matrix[rowNumber - 1] = cells;
    });
    return Array.from(matrix, (r) => r || []);
  } catch (e) {
    // Archivos con XML con prefijo de namespace (ej. Bancolombia, DIAN):
    // ExcelJS no los abre — se usa el lector tolerante.
    return readXlsxRows(buffer);
  }
}

const norm = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

// Palabras que suelen tener los encabezados de un extracto. La fila con más
// coincidencias (y al menos fecha + algún monto) es la de encabezados — los
// extractos traen antes un preámbulo (cliente, cuenta, periodo, resumen).
const HEADER_HINTS = {
  fecha: /^(fecha|fecha (de )?(movimiento|transaccion|operacion|valor)|date)$/,
  descripcion: /(descripcion|detalle|concepto|transaccion|movimiento)/,
  referencia: /(referencia|documento|dcto|doc\.?|comprobante|ref\.?$|numero)/,
  valor: /^(valor|monto|importe|valor (del )?movimiento)$/,
  debito: /(debito|cargo|retiro|egreso|salida)/,
  credito: /(credito|abono|deposito|ingreso|entrada)/,
  saldo: /saldo/,
};

// "1/04", "01/04/2026", "2026-04-01", Date o serial de Excel.
function looksLikeDate(v) {
  if (v instanceof Date) return !isNaN(v);
  if (typeof v === 'number') return v > 20000 && v < 80000;
  return /^\s*\d{1,4}[/\-.]\d{1,2}([/\-.]\d{1,4})?(\s|$)/.test(String(v ?? ''));
}

// "-14,500.00", "$ 1.234,56", "(500)", ".92" o número.
function looksLikeAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  const t = String(v ?? '').trim();
  return t !== '' && /^[-+(]?\s*\$?\s*[\d.,]*\d[\d.,]*\)?\s*(cop)?$/i.test(t);
}

function headerScore(row) {
  const cells = (row || []).map(norm).filter(Boolean);
  let score = 0;
  let hasDate = false;
  let hasAmount = false;
  for (const c of cells) {
    if (c.length > 40) continue;
    for (const [key, re] of Object.entries(HEADER_HINTS)) {
      if (re.test(c)) {
        score += 1;
        if (key === 'fecha') hasDate = true;
        if (['valor', 'debito', 'credito'].includes(key)) hasAmount = true;
        break;
      }
    }
  }
  return hasDate && hasAmount ? score + 10 : score;
}

// Fechas completas en el preámbulo (DESDE/HASTA, "Periodo: ..."): definen el
// año de los movimientos cuando el banco los trae como "1/04" sin año.
function findPeriod(matrix, headerIndex) {
  const dates = [];
  for (const row of matrix.slice(0, headerIndex)) {
    for (const cell of row || []) {
      if (cell instanceof Date && !isNaN(cell)) { dates.push(cell.toISOString().slice(0, 10)); continue; }
      const t = String(cell ?? '');
      let m = t.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (m) { dates.push(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`); continue; }
      m = t.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
      if (m) dates.push(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
    }
  }
  const valid = dates.filter((d) => !isNaN(new Date(d)));
  if (valid.length === 0) return null;
  valid.sort();
  return { from: valid[0], to: valid[valid.length - 1] };
}

/**
 * Matriz → { headers, rows, rowNumbers, meta }. Detecta la fila de
 * encabezados (no siempre es la 1), descarta filas vacías y nombra columnas
 * sin título ("Columna N") o repetidas ("SALDO (2)") para que el mapeo sea
 * inequívoco.
 */
function matrixToTable(matrix) {
  const scan = matrix.slice(0, 60);
  let headerIndex = -1;
  let best = 0;
  scan.forEach((row, idx) => {
    const sc = headerScore(row);
    if (sc > best) { best = sc; headerIndex = idx; }
  });
  if (headerIndex < 0 || best < 2) headerIndex = matrix.findIndex((r) => (r || []).filter((c) => !isBlank(c)).length >= 2);
  if (headerIndex < 0) return { headers: [], rows: [], rowNumbers: [], meta: {} };

  const dataRows = matrix.slice(headerIndex + 1);
  const width = Math.max(
    (matrix[headerIndex] || []).length,
    ...dataRows.slice(0, 200).map((r) => (r || []).reduce((w, c, i) => (isBlank(c) ? w : i + 1), 0))
  );

  const seen = new Map();
  const headers = [];
  for (let i = 0; i < width; i += 1) {
    let h = String(matrix[headerIndex][i] ?? '').trim();
    const colHasData = dataRows.some((r) => !isBlank((r || [])[i]));
    if (!h) {
      if (!colHasData) { headers.push(null); continue; }
      h = `Columna ${i + 1}`;
    }
    const count = (seen.get(h) || 0) + 1;
    seen.set(h, count);
    headers.push(count > 1 ? `${h} (${count})` : h);
  }

  // Columnas de fecha y monto según el encabezado: una fila solo es
  // movimiento si tiene fecha válida Y algún monto numérico. Así se descartan
  // los bloques que los extractos de varias páginas repiten en cada hoja
  // (datos del cliente, periodo, resumen de saldos, encabezado de nuevo) y
  // el pie ("FIN ESTADO DE CUENTA"). Si no se reconocen esas columnas, no se
  // filtra (el mapeo manual decide).
  const headerNorm = (matrix[headerIndex] || []).map(norm);
  const dateCol = headerNorm.findIndex((h) => HEADER_HINTS.fecha.test(h));
  const amountColIdx = headerNorm
    .map((h, i) => (['valor', 'debito', 'credito'].some((k) => HEADER_HINTS[k].test(h)) ? i : -1))
    .filter((i) => i >= 0);
  const canFilter = dateCol >= 0 && amountColIdx.length > 0;

  const rows = [];
  const rowNumbers = [];
  let ignoredRows = 0;
  dataRows.forEach((r, idx) => {
    const cells = r || [];
    if (cells.every(isBlank)) return;
    if (canFilter && !(looksLikeDate(cells[dateCol]) && amountColIdx.some((i) => looksLikeAmount(cells[i])))) {
      ignoredRows += 1;
      return;
    }
    const data = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const v = cells[i];
      data[h] = v === undefined || v === null ? '' : v;
    });
    rows.push(data);
    rowNumbers.push(headerIndex + idx + 2);
  });

  return {
    headers: headers.filter(Boolean),
    rows,
    rowNumbers,
    meta: { header_row: headerIndex + 1, period: findPeriod(matrix, headerIndex), ignored_rows: ignoredRows },
  };
}

/**
 * Lee el archivo del extracto y lo reduce a { headers, rows, rowNumbers, meta }.
 * @param {Buffer} buffer
 * @param {string} originalName - para decidir Excel vs texto delimitado por extensión
 */
async function parseStatementFile(buffer, originalName) {
  const ext = (originalName || '').toLowerCase().split('.').pop();
  if (ext === 'xls') {
    // .xls (Excel 97-2003, binario) no lo lee ninguna de las librerías del
    // proyecto. Algunos bancos nombran .xls archivos que en realidad son
    // HTML o texto: se intenta como texto; si no, error claro.
    const head = buffer.slice(0, 8).toString('hex');
    if (head.startsWith('d0cf11e0')) {
      const err = new Error('El formato .xls (Excel 97-2003) no es compatible: ábrelo en Excel y guárdalo como .xlsx o CSV');
      err.statusCode = 400;
      throw err;
    }
    if (head.startsWith('504b0304')) return matrixToTable(await parseExcelMatrix(buffer)); // es un .xlsx renombrado
  }
  if (ext === 'xlsx') return matrixToTable(await parseExcelMatrix(buffer));
  // CSV/TXT: se asume UTF-8; si el banco exporta en otra codificación se
  // revisa como caso puntual cuando aparezca.
  return matrixToTable(parseDelimitedMatrix(buffer.toString('utf8')));
}

/**
 * Sugerencia de mapeo para la primera importación de un formato: columnas
 * por nombre de encabezado, formato de fecha y separador decimal por las
 * muestras. El usuario la puede cambiar en el modal.
 */
function suggestMapping(headers, rows) {
  const find = (key) => headers.find((h) => HEADER_HINTS[key].test(norm(h))) || '';
  const fecha = find('fecha');
  const valor = find('valor');
  const debito = valor ? '' : find('debito');
  const credito = valor ? '' : find('credito');
  const column_mapping = {
    fecha,
    descripcion: find('descripcion'),
    referencia: find('referencia'),
    modo: !valor && debito && credito ? 'debito_credito' : 'unico',
    valor,
    debito,
    credito,
  };

  const samples = rows.slice(0, 50);
  // Formato de fecha: si algún primer componente > 12 es día; si algún
  // segundo componente > 12, es mes/día.
  let dateFormat = 'DD/MM/YYYY';
  const dateSamples = samples
    .map((r) => r[fecha])
    .filter((v) => typeof v === 'string' && looksLikeDate(v))
    .map((t) => t.trim().split(/\s+/)[0]);
  const yearFirst = dateSamples.filter((t) => /^\d{4}[/\-.]/.test(t)).length;
  if (yearFirst > dateSamples.length / 2) dateFormat = 'YYYY/MM/DD';
  else if (dateSamples.some((t) => Number(t.split(/[/\-.]/)[1]) > 12) && !dateSamples.some((t) => Number(t.split(/[/\-.]/)[0]) > 12)) {
    dateFormat = 'MM/DD/YYYY';
  }

  // Separador decimal: el último separador de los montos con decimales.
  let commas = 0;
  let dots = 0;
  const amountCols = [valor, debito, credito].filter(Boolean);
  for (const r of samples) {
    for (const c of amountCols) {
      const t = String(r[c] ?? '').trim();
      const m = t.match(/[.,](\d{1,2})$/);
      if (m) { if (t[t.length - m[1].length - 1] === ',') commas += 1; else dots += 1; }
    }
  }
  const decimal_separator = dots > commas ? '.' : ',';
  return { column_mapping, date_format: dateFormat, decimal_separator };
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

// Año para fechas sin año ("1/04"): el del periodo del extracto que
// contenga ese mes (maneja extractos que cruzan diciembre→enero); sin
// periodo, el año actual — o el anterior si la fecha quedaría en el futuro.
function inferYear(month, day, period) {
  const m = Number(month);
  if (period?.from && period?.to) {
    const fromY = Number(period.from.slice(0, 4));
    const toY = Number(period.to.slice(0, 4));
    if (fromY === toY) return String(fromY);
    return String(m >= Number(period.from.slice(5, 7)) ? fromY : toY);
  }
  const now = new Date();
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), m - 1, Number(day)));
  return String(candidate > now ? now.getUTCFullYear() - 1 : now.getUTCFullYear());
}

/**
 * Convierte un valor de fecha (string en date_format, Date de Excel o serial
 * numérico de Excel) a 'YYYY-MM-DD'.
 * @param {object} [options] - { period: { from, to } } para fechas sin año
 */
function parseDateValue(raw, dateFormat, options = {}) {
  if (raw instanceof Date && !isNaN(raw)) {
    return raw.toISOString().slice(0, 10);
  }
  // Serial de Excel (celda con formato fecha leída por el lector tolerante).
  if (typeof raw === 'number' && raw > 20000 && raw < 80000) return excelSerialToISO(raw);
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // ISO directo (algunos bancos ya exportan así, sin importar el date_format elegido).
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);

  // Descarta la hora si viene ("01/04/2026 10:15").
  const parts = text.split(/\s+/)[0].split(/[/\-.]/).map((p) => p.trim()).filter(Boolean);
  const order = (dateFormat || 'DD/MM/YYYY').toUpperCase().split(/[/\-.]/);
  const map = {};
  if (parts.length === 3) {
    order.forEach((token, idx) => { map[token] = parts[idx]; });
  } else if (parts.length === 2) {
    // Día y mes sin año (Bancolombia: "1/04"), en el orden del formato elegido.
    order.filter((t) => t !== 'YYYY').forEach((token, idx) => { map[token] = parts[idx]; });
    if (map.DD && map.MM) map.YYYY = inferYear(map.MM, map.DD, options.period);
  } else {
    return null;
  }

  let { DD: day, MM: month, YYYY: year } = map;
  if (!day || !month || !year) return null;
  if (year.length === 2) year = `20${year}`;
  if (isNaN(Number(month)) && MONTHS_ES[month.toLowerCase().slice(0, 3)]) {
    month = String(MONTHS_ES[month.toLowerCase().slice(0, 3)]);
  }

  day = String(day).padStart(2, '0');
  month = String(month).padStart(2, '0');
  if (day.length !== 2 || month.length !== 2 || year.length !== 4) return null;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
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

  // Si el monto trae ambos separadores, el último es el decimal sin importar
  // lo configurado ("14,500.00" o "14.500,00"); con uno solo repetido
  // ("1.234.567") es de miles. Solo el caso ambiguo usa el configurado —
  // antes "14,500.00" con separador ',' se leía en silencio como 14,5.
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  let sep = decimalSeparator;
  if (lastComma >= 0 && lastDot >= 0) sep = lastComma > lastDot ? ',' : '.';
  else if (lastComma >= 0 && (text.match(/,/g) || []).length > 1) sep = '.';
  else if (lastDot >= 0 && (text.match(/\./g) || []).length > 1) sep = ',';
  if (sep === ',') {
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
function buildTransactionsFromRows(rows, columnMapping, amountFormat, dateFormat, options = {}) {
  const decimalSeparator = amountFormat?.decimal_separator || ',';
  const modo = columnMapping?.modo || 'unico';
  const amountCols = modo === 'debito_credito' ? [columnMapping.debito, columnMapping.credito] : [columnMapping.valor];

  const transactions = [];
  const errors = [];
  let skipped = 0;

  rows.forEach((row, idx) => {
    // Número de fila real del archivo (el encabezado no siempre es la fila 1).
    const rowNumber = options.rowNumbers?.[idx] ?? idx + 2;
    const dateRaw = row[columnMapping.fecha];
    // Filas sin fecha ni monto (totales, "FIN ESTADO DE CUENTA", notas del
    // banco) no son movimientos: se omiten sin contarlas como error.
    if (isBlank(dateRaw) && amountCols.every((c) => isBlank(row[c]))) { skipped += 1; return; }
    const date = parseDateValue(dateRaw, dateFormat, { period: options.period });
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

  return { transactions, errors, skipped };
}

module.exports = {
  parseStatementFile,
  suggestMapping,
  computeFileSignature,
  previewRows,
  parseDateValue,
  parseAmountValue,
  buildTransactionsFromRows,
};
