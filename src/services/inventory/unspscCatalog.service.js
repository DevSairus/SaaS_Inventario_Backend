// backend/src/services/inventory/unspscCatalog.service.js
//
// Catálogo UNSPSC v14 en español (la traducción de Colombia Compra Eficiente
// que trae la caja de herramientas de factura electrónica de la DIAN,
// "Clasificador de Bienes y Servicios.xls"), para que el usuario busque el
// código de sus productos. Se carga a memoria la primera vez (~49.000
// códigos de producto, 600 KB comprimido) y se busca ahí.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILE = path.join(__dirname, '../../data/unspsc_v14.tsv.gz');
let catalog = null;

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function load() {
  if (catalog) return catalog;
  const text = zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8');
  catalog = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [code, name, className, family, segment] = line.split('\t');
    catalog.push({ code, name, class_name: className, family, segment, _name: norm(name), _all: norm(`${name} ${className} ${family}`) });
  }
  return catalog;
}

const publicRow = ({ code, name, class_name, family, segment }) => ({ code, name, class_name, family, segment });

/** Un código exacto, o null. */
function findUnspsc(code) {
  const c = String(code || '').trim();
  const row = load().find((r) => r.code === c);
  return row ? publicRow(row) : null;
}

/**
 * Búsqueda por código (prefijo, p. ej. "2517") o por palabras ("pastillas
 * freno"): todas las palabras deben aparecer en el producto, su clase o su
 * familia. Primero los que las tienen en el nombre del producto.
 */
function searchUnspsc(query, limit = 30) {
  const q = String(query || '').trim();
  if (!q) return [];
  const rows = load();
  if (/^\d+$/.test(q)) return rows.filter((r) => r.code.startsWith(q)).slice(0, limit).map(publicRow);
  const words = norm(q).split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const inName = [];
  const inContext = [];
  for (const r of rows) {
    if (!words.every((w) => r._all.includes(w))) continue;
    (words.every((w) => r._name.includes(w)) ? inName : inContext).push(r);
    if (inName.length >= limit) break;
  }
  return [...inName, ...inContext].slice(0, limit).map(publicRow);
}

module.exports = { searchUnspsc, findUnspsc };
