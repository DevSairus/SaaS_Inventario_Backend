// backend/src/services/projects/bomParser.js
//
// Lista de materiales pegada desde Excel (o leída de un .xlsx en el
// navegador, que la convierte al mismo texto con tabuladores). Función pura:
// no toca la BD (ver projectBom.service.js para el emparejamiento).
//
// Columnas: con encabezado se reconocen por nombre (código, descripción,
// cantidad, unidad, costo); sin encabezado, la cantidad es la primera columna
// numérica después de la primera, el costo la siguiente numérica, la unidad
// el primer texto corto después de la cantidad y lo que va antes de la
// cantidad es código y descripción (o solo uno de los dos).

const MAX_LINES = 1000;

const normalize = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const HEADER_KEYWORDS = {
  code: ['codigo', 'cod', 'sku', 'referencia', 'ref', 'item code', 'part number', 'codigo producto'],
  description: ['descripcion', 'producto', 'nombre', 'material', 'articulo', 'detalle', 'item', 'equipo'],
  quantity: ['cantidad', 'cant', 'qty', 'unidades requeridas', 'requerido', 'cantidad requerida'],
  unit: ['unidad', 'und', 'un', 'um', 'u m', 'unidad de medida', 'medida'],
  unit_cost: ['costo', 'costo unitario', 'precio', 'precio unitario', 'valor unitario', 'vr unitario', 'valor', 'costo unit'],
};

function headerField(cell) {
  const n = normalize(cell);
  if (!n) return null;
  for (const [field, words] of Object.entries(HEADER_KEYWORDS)) {
    if (words.includes(n)) return field;
  }
  // "Cantidad total", "Costo unitario estimado"...: por prefijo.
  for (const [field, words] of Object.entries(HEADER_KEYWORDS)) {
    if (words.some((w) => w.length >= 4 && n.startsWith(w))) return field;
  }
  return null;
}

/**
 * Número en formato colombiano o anglo: "1.234,5", "1,234.5", "12", "$ 3.500".
 * Con un solo separador repetido en grupos de 3 se toma como miles.
 * @returns {number|null}
 */
function parseLocaleNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim().replace(/[$\s ]/g, '').replace(/^COP/i, '');
  if (!s || !/^-?[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s) && (s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    else if (/^-?\d{1,3}\.\d{3}$/.test(s)) s = s.replace('.', ''); // "1.500" = mil quinientos
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  const delimiter = lines.some((l) => l.includes('\t')) ? '\t' : (lines.some((l) => l.includes(';')) ? ';' : null);
  return lines.map((l) => (delimiter ? l.split(delimiter) : [l]).map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim()));
}

function detectHeader(firstRow) {
  const mapping = {};
  firstRow.forEach((cell, idx) => {
    const field = headerField(cell);
    if (field && mapping[field] === undefined) mapping[field] = idx;
  });
  return mapping.quantity !== undefined && (mapping.code !== undefined || mapping.description !== undefined) ? mapping : null;
}

// Sin encabezado: deduce las columnas mirando todas las filas.
function inferColumns(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const numericShare = [];
  for (let c = 0; c < width; c++) {
    const filled = rows.filter((r) => (r[c] ?? '') !== '');
    const numeric = filled.filter((r) => parseLocaleNumber(r[c]) !== null);
    numericShare[c] = filled.length ? numeric.length / filled.length : 0;
  }
  let quantity = -1;
  for (let c = 1; c < width; c++) {
    if (numericShare[c] >= 0.8) { quantity = c; break; }
  }
  if (quantity < 0) return null;
  const mapping = { quantity };
  if (quantity >= 2) {
    mapping.code = 0;
    mapping.description = 1;
  } else {
    mapping.code_or_description = 0;
  }
  for (let c = quantity + 1; c < width; c++) {
    if (numericShare[c] >= 0.8 && mapping.unit_cost === undefined) mapping.unit_cost = c;
    else if (numericShare[c] < 0.5 && mapping.unit === undefined) {
      const short = rows.every((r) => String(r[c] ?? '').length <= 12);
      if (short) mapping.unit = c;
    }
  }
  return mapping;
}

/**
 * @param {string} text - lo pegado (TSV de Excel, o líneas con ';')
 * @returns {{ rows: Array<{ line_no, input_code, input_description, unit, quantity, unit_cost, raw }>, errors: Array<{ line_no, message }>, header: boolean }}
 */
function parseBomText(text) {
  const all = splitLines(text);
  if (all.length === 0) return { rows: [], errors: [{ line_no: 0, message: 'No hay nada para leer: pega las filas copiadas desde Excel' }], header: false };

  let mapping = detectHeader(all[0]);
  const header = Boolean(mapping);
  const body = header ? all.slice(1) : all;
  if (!mapping) mapping = inferColumns(body);
  if (!mapping) {
    return { rows: [], errors: [{ line_no: 0, message: 'No se encontró la columna de cantidad. Incluye el encabezado (Código, Descripción, Cantidad, Unidad, Costo) o una columna numérica de cantidades.' }], header };
  }
  if (body.length > MAX_LINES) {
    return { rows: [], errors: [{ line_no: 0, message: `Máximo ${MAX_LINES} líneas por carga (llegaron ${body.length})` }], header };
  }

  const rows = [];
  const errors = [];
  body.forEach((cells, i) => {
    const line_no = i + 1;
    const cell = (k) => (mapping[k] === undefined ? '' : String(cells[mapping[k]] ?? '').trim());
    let input_code = cell('code');
    let input_description = cell('description');
    if (mapping.code_or_description !== undefined) {
      const v = cell('code_or_description');
      // Un "código" no lleva espacios y es corto; si no, es descripción.
      if (v && !/\s/.test(v) && v.length <= 40) input_code = v;
      else input_description = v;
    }
    const quantity = parseLocaleNumber(cell('quantity'));
    const costRaw = cell('unit_cost');
    const unit_cost = costRaw ? parseLocaleNumber(costRaw) : null;
    const raw = cells.join(' | ');

    if (!input_code && !input_description) {
      if (cells.some((c) => c)) errors.push({ line_no, message: 'Sin código ni descripción', raw });
      return;
    }
    if (quantity === null || quantity <= 0) {
      errors.push({ line_no, message: `Cantidad inválida: "${cell('quantity')}"`, raw });
      return;
    }
    if (costRaw && (unit_cost === null || unit_cost < 0)) {
      errors.push({ line_no, message: `Costo inválido: "${costRaw}"`, raw });
      return;
    }
    rows.push({
      line_no,
      input_code: input_code.slice(0, 100) || null,
      input_description: input_description.slice(0, 255) || null,
      unit: cell('unit').slice(0, 30) || null,
      quantity: Math.round(quantity * 10000) / 10000,
      unit_cost: unit_cost === null ? null : Math.round(unit_cost * 100) / 100,
      raw,
    });
  });
  return { rows, errors, header };
}

module.exports = { parseBomText, parseLocaleNumber, normalize, MAX_LINES };
