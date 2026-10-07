// backend/src/services/payroll/pila/pilaExcel.service.js
//
// PILA en Excel para operadores que reciben la planilla en ese formato.
// Como cada operador/plantilla ordena y nombra distinto las columnas, la
// empresa sube una vez un Excel de muestra (el que su operador acepta) y
// Pitbox "aprende" la plantilla:
//   - en qué hoja y fila están los encabezados del aportante (registro 01)
//     y de los cotizantes (registro 02), y dónde empiezan los datos;
//   - qué campo de la PILA va en cada columna (por el texto del
//     encabezado, ver pilaFieldCatalog.js) -- el usuario confirma o ajusta;
//   - el tipo de cada celda (número, texto, fecha) y si las tarifas van
//     como fracción (0.16) o porcentaje (16).
// Si la muestra no tiene encabezados pero sus filas empiezan con 01/02, se
// asume el orden estándar de columnas. La plantilla se guarda en
// payroll_settings.pila_excel_template; sin plantilla se usa la estándar
// (data/pila-excel-default-template.json: una hoja con encabezado del
// aportante, sus datos, encabezado de cotizantes y una fila por cotizante).

const { R1, R2, formatField } = require('./pilaLayout');
const { matchHeader, countMatches, labelOf, FIELD_OPTIONS } = require('./pilaFieldCatalog');

const LAYOUT = { r1: R1, r2: R2 };
const MIN_LABELS = 3;

const cellValue = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return v.text;
    return null;
  }
  return v;
};

const kindOfRecordCell = (v) => {
  const s = String(v ?? '').trim();
  if (s === '1' || s === '01') return 'r1';
  if (s === '2' || s === '02') return 'r2';
  return null;
};

const typeOf = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return 'date';
  if (typeof v === 'number') return 'number';
  return 'text';
};

/**
 * Aprende la plantilla de un Excel de muestra. No guarda nada.
 * @returns {{ template, unmapped: Array, summary }}
 */
async function learnTemplate(buffer, filename = '') {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('No se pudo leer el archivo: debe ser un Excel .xlsx');
  }

  const sections = [];
  const widths = {};
  wb.worksheets.forEach((ws) => {
    widths[ws.name] = {};
    ws.columns?.forEach((c, i) => { if (c?.width) widths[ws.name][i + 1] = c.width; });
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      rows.push({ rowNumber, cells: row.values.slice(1).map(cellValue) });
    });

    for (let i = 0; i < rows.length; i++) {
      const { rowNumber, cells } = rows[i];
      const texts = cells.map((c) => (typeof c === 'string' ? c : ''));
      const m1 = countMatches(texts, 'r1');
      const m2 = countMatches(texts, 'r2');
      if (Math.max(m1, m2) < MIN_LABELS) continue;
      const kind = m2 >= m1 ? 'r2' : 'r1';
      // Datos: filas siguientes hasta la próxima fila de encabezados.
      const data = [];
      for (let j = i + 1; j < rows.length; j++) {
        const t = rows[j].cells.map((c) => (typeof c === 'string' ? c : ''));
        if (Math.max(countMatches(t, 'r1'), countMatches(t, 'r2')) >= MIN_LABELS) break;
        if (rows[j].rowNumber !== (data.length ? data[data.length - 1].rowNumber + 1 : rowNumber + 1)) break;
        data.push(rows[j]);
      }
      const taken = new Set();
      const columns = [];
      cells.forEach((c, idx) => {
        if (c == null || c === '') return;
        const label = String(c);
        const field = matchHeader(label.trim(), kind, taken);
        if (field) taken.add(field);
        const sample = data.map((d) => d.cells[idx]).find((v) => v != null && String(v).trim() !== '');
        const col = { col: idx + 1, label, field, type: typeOf(sample) || 'auto' };
        if (field && /^tarifa/.test(field) && typeof sample === 'number' && sample > 1) col.scale = 100;
        // Códigos numéricos guardados como texto: con ceros a la izquierda
        // ("01") o sin ellos ("1"), como venga en la muestra.
        const spec = field && LAYOUT[kind].find(([f]) => f === field);
        if (spec && spec[2] === 'N' && typeof sample === 'string' && /^\d+$/.test(sample.trim()) && sample.trim().length < spec[1]) col.pad = false;
        columns.push(col);
      });
      sections.push({ kind, sheet: ws.name, labelRow: rowNumber, dataStartRow: rowNumber + 1, sampleRows: data.length, columns });
      i += data.length;
    }

    // Sin encabezados reconocibles: filas que empiezan por 01/02, en el
    // orden estándar de columnas.
    if (!sections.some((s) => s.sheet === ws.name)) {
      for (const kind of ['r1', 'r2']) {
        const first = rows.find((r) => kindOfRecordCell(r.cells[0]) === kind);
        if (!first) continue;
        sections.push({
          kind, sheet: ws.name, labelRow: null, dataStartRow: first.rowNumber, sampleRows: 1,
          columns: LAYOUT[kind].map(([field], idx) => ({ col: idx + 1, label: labelOf(kind, field), field, type: typeOf(first.cells[idx]) || 'auto' })),
        });
      }
    }
  });

  if (!sections.some((s) => s.kind === 'r2')) {
    throw new Error('No se encontró la tabla de cotizantes: el Excel debe tener una fila de encabezados (Documento, IBC, Días...) o filas que empiecen con 02.');
  }
  // Una sección de cada tipo (la primera que aparezca).
  const unique = ['r1', 'r2'].map((k) => sections.find((s) => s.kind === k)).filter(Boolean);

  const template = {
    version: 1,
    source_name: filename || null,
    sheets: wb.worksheets.map((ws) => ws.name).filter((n) => unique.some((s) => s.sheet === n)),
    sections: unique.map((s) => ({ ...s, sampleRows: Math.max(1, s.sampleRows || 1) })),
    widths,
  };
  return { template, ...describe(template) };
}

// Resumen para la pantalla: columnas sin campo y campos importantes faltantes.
const KEY_FIELDS = ['documento', 'tipoDoc', 'diasEps', 'ibcEps', 'cotizacionEps', 'cotizacionAfp', 'cotizacionArl', 'aporteCcf'];
function describe(template) {
  const unmapped = [];
  for (const s of template.sections) {
    for (const c of s.columns) if (!c.field) unmapped.push({ kind: s.kind, col: c.col, label: c.label });
  }
  const r2 = template.sections.find((s) => s.kind === 'r2');
  const present = new Set((r2?.columns || []).map((c) => c.field).filter(Boolean));
  return {
    unmapped,
    missingKeyFields: KEY_FIELDS.filter((f) => !present.has(f)).map((f) => ({ field: f, label: labelOf('r2', f) })),
    hasHeaderSection: template.sections.some((s) => s.kind === 'r1'),
    fieldOptions: FIELD_OPTIONS,
  };
}

/* ── Validación de una plantilla editada por el usuario ───────────────── */

function sanitizeTemplate(input) {
  if (!input || !Array.isArray(input.sections)) throw new Error('Plantilla inválida');
  const sections = input.sections
    .filter((s) => ['r1', 'r2'].includes(s.kind))
    .map((s) => {
      const fields = new Set(LAYOUT[s.kind].map(([f]) => f));
      const used = new Set();
      return {
        kind: s.kind,
        sheet: String(s.sheet || 'PILA').slice(0, 31),
        labelRow: s.labelRow == null ? null : Math.max(1, Math.min(1000, parseInt(s.labelRow, 10) || 1)),
        dataStartRow: Math.max(1, Math.min(1000, parseInt(s.dataStartRow, 10) || 1)),
        sampleRows: Math.max(1, Math.min(1000, parseInt(s.sampleRows, 10) || 1)),
        columns: (s.columns || []).slice(0, 300).map((c) => {
          let field = fields.has(c.field) && !used.has(c.field) ? c.field : null;
          if (field) used.add(field);
          return {
            col: Math.max(1, Math.min(500, parseInt(c.col, 10) || 1)),
            label: String(c.label ?? '').slice(0, 120),
            field,
            type: ['number', 'text', 'date', 'auto'].includes(c.type) ? c.type : 'auto',
            ...(Number(c.scale) === 100 ? { scale: 100 } : {}),
            ...(c.pad === false ? { pad: false } : {}),
          };
        }),
      };
    });
  if (!sections.some((s) => s.kind === 'r2')) throw new Error('La plantilla debe tener la tabla de cotizantes');
  const unique = ['r1', 'r2'].map((k) => sections.find((s) => s.kind === k)).filter(Boolean);
  return {
    version: 1,
    source_name: input.source_name ? String(input.source_name).slice(0, 120) : null,
    sheets: [...new Set(unique.map((s) => s.sheet))],
    sections: unique,
    widths: typeof input.widths === 'object' && input.widths ? input.widths : {},
  };
}

/* ── Generación ──────────────────────────────────────────────────────── */

// Valor de una celda según el campo y el tipo aprendido de la muestra.
function excelValue(kind, field, raw, column) {
  const spec = LAYOUT[kind].find(([f]) => f === field);
  if (!spec) return null;
  const [, len, type, dec] = spec;
  if (typeof raw === 'string') raw = raw.trim();
  const empty = raw == null || raw === '';
  // Columna vacía en la muestra: se deja vacía mientras no haya valor.
  if (column.type === 'auto' && (empty || ((type === 'N' || type === 'R') && Number(raw) === 0))) return '';
  if (empty) {
    if (type === 'N' || type === 'R') return column.type === 'text' ? formatField(0, len, type, dec) : 0;
    return '';
  }
  if (type === 'D') {
    if (column.type === 'date') {
      const [y, m, d] = String(raw).slice(0, 10).split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    }
    return String(raw).slice(0, 10);
  }
  if (type === 'R') {
    const n = (Number(raw) || 0) * (column.scale || 1);
    return column.type === 'text' ? formatField(raw, len, type, dec) : n;
  }
  if (type === 'N') {
    // Texto: tal como en el archivo plano ("05", "0001"); número: valor.
    if (column.type === 'text') return column.pad === false ? String(Number(raw)) : formatField(raw, len, type, dec);
    const n = Number(raw);
    return Number.isFinite(n) ? n : String(raw);
  }
  // Alfanumérico: sin relleno.
  return formatField(raw, len, type, dec).trim();
}

/**
 * @param {object} template
 * @param {object} header - valores del registro 01 (como en pila.service)
 * @param {Array<object>} details - valores de cada registro 02 (con secuencia)
 * @returns {Promise<Buffer>}
 */
async function renderExcel(template, header, details) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pitbox';
  const sheets = new Map();
  const sheet = (name) => {
    if (!sheets.has(name)) {
      const ws = wb.addWorksheet(name);
      for (const [col, w] of Object.entries(template.widths?.[name] || {})) ws.getColumn(Number(col)).width = Number(w) || undefined;
      sheets.set(name, ws);
    }
    return sheets.get(name);
  };
  template.sheets.forEach(sheet);

  // Secciones en la misma hoja: se respeta el orden y la separación de la
  // muestra; si la primera es la de cotizantes (largo variable), la
  // siguiente se corre según la cantidad de filas.
  const ordered = [...template.sections].sort((a, b) => (a.sheet === b.sheet ? (a.labelRow ?? a.dataStartRow) - (b.labelRow ?? b.dataStartRow) : 0));
  const offset = new Map();
  for (const s of ordered) {
    const ws = sheet(s.sheet);
    const shift = offset.get(s.sheet) || 0;
    const records = s.kind === 'r1' ? [{ tipoRegistro: '01', ...header }] : details.map((d) => ({ tipoRegistro: '02', ...d }));
    if (s.labelRow) {
      const row = ws.getRow(s.labelRow + shift);
      for (const c of s.columns) row.getCell(c.col).value = c.label;
      row.font = { bold: true };
    }
    records.forEach((rec, i) => {
      const row = ws.getRow(s.dataStartRow + shift + i);
      for (const c of s.columns) {
        if (!c.field) continue;
        row.getCell(c.col).value = excelValue(s.kind, c.field, rec[c.field], c);
        if (c.type === 'date') row.getCell(c.col).numFmt = 'yyyy-mm-dd';
      }
    });
    // La muestra tenía N filas de datos en esta sección: lo que viene
    // después en la misma hoja se corre por la diferencia.
    offset.set(s.sheet, shift + (records.length - (s.sampleRows || 1)));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { learnTemplate, sanitizeTemplate, renderExcel, describe };
