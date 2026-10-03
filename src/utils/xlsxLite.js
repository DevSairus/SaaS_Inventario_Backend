// backend/src/utils/xlsxLite.js
//
// Lector mínimo de .xlsx a matriz de valores, tolerante a archivos que
// ExcelJS no abre. Varios sistemas (el portal DIAN, la sucursal virtual de
// Bancolombia...) generan el XML del xlsx con prefijo de namespace
// (<x:worksheet>, <x:c>, <x:sst>...), y a veces sin atributo r="A1" en las
// celdas ni archivo de estilos. Es OOXML válido, pero ExcelJS falla con
// "Cannot read properties of undefined (reading 'sheets')". Aquí se lee el
// zip directamente con expresiones tolerantes al prefijo.
//
// Devuelve solo valores: texto, o número para celdas numéricas (las fechas
// "reales" de Excel llegan como número serial — ver excelSerialToISO).

'use strict';

const AdmZip = require('adm-zip');

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

// Concatena todos los <t> de un fragmento (texto simple o rich text <r><t>).
function textOf(fragment) {
  const parts = [];
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  let m;
  while ((m = re.exec(fragment)) !== null) parts.push(decodeXml(m[1]));
  return parts.join('');
}

function colIndex(ref) {
  const letters = String(ref).replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsxRows(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (e) {
    const err = new Error('El archivo no es un Excel (.xlsx) válido');
    err.statusCode = 400;
    throw err;
  }
  const entries = zip.getEntries();
  const find = (re) => entries.find((e) => re.test(e.entryName));

  const sstEntry = find(/^xl\/sharedStrings\.xml$/i);
  const shared = [];
  if (sstEntry) {
    const xml = sstEntry.getData().toString('utf8');
    const re = /<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) shared.push(textOf(m[1]));
  }

  const sheetEntry = find(/^xl\/worksheets\/sheet1\.xml$/i) || find(/^xl\/worksheets\/[^/]+\.xml$/i);
  if (!sheetEntry) {
    const err = new Error('El Excel no tiene hojas legibles');
    err.statusCode = 400;
    throw err;
  }
  const sheetXml = sheetEntry.getData().toString('utf8');

  const rows = [];
  const rowRe = /<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const cells = [];
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let cm;
    let pos = 0;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const idx = ref ? colIndex(ref) : pos;
      pos = idx + 1;
      const vMatch = inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
      let value = null;
      if (type === 's') value = vMatch ? shared[Number(vMatch[1])] ?? '' : '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str' || type === 'b' || type === 'e') value = vMatch ? decodeXml(vMatch[1]) : '';
      else if (vMatch) value = Number(vMatch[1]);
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Serial de fecha de Excel (sistema 1900) → 'YYYY-MM-DD'. */
function excelSerialToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

module.exports = { readXlsxRows, excelSerialToISO };
