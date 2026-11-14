// backend/src/services/payroll/pila/pilaCodes.js
//
// Código PILA de una administradora según el papel en que se reporta (EPS,
// pensión, caja de compensación o ARL).
//
// Los códigos son nacionales, así que:
//   1. Si el proveedor del tenant tiene un código que corresponde a ese tipo,
//      se usa (el tenant puede corregirlo en Proveedores).
//   2. Si no, se toma del catálogo de Pitbox (data/payroll-funds-colombia.js)
//      por el NIT del proveedor. Así funciona aunque el tenant creó el
//      proveedor a mano o nunca cargó el catálogo.
// Una entidad con dos papeles (Compensar: EPS008 como EPS, CCF24 como caja)
// guarda un solo pila_code; el del otro papel sale del catálogo.

const { PAYROLL_FUNDS_COLOMBIA } = require('../../../data/payroll-funds-colombia');

const digits = (v) => String(v || '').replace(/\D/g, '');

// Forma del código según el tipo (para no reportar el código de EPS como caja).
const SHAPE = {
  ccf: (c) => /^CCF\d{2}$/.test(c),
  arl: (c) => /^14-\d{1,2}$/.test(c),
  afp: (c) => /^(\d{6}|25-\d{1,2}|FSP\d{3})$/.test(c),
  eps: (c) => !/^CCF\d{2}$/.test(c) && !/^14-\d/.test(c) && !/^\d{6}$/.test(c) && !/^25-\d/.test(c),
};

/** Entrada del catálogo para un NIT (con o sin dígito de verificación). */
function catalogEntry(taxId) {
  const d = digits(taxId);
  if (!d) return null;
  return PAYROLL_FUNDS_COLOMBIA.find((f) => d === f.tax_id || (d.length === f.tax_id.length + 1 && d.startsWith(f.tax_id))) || null;
}

/** Código del catálogo de una entidad para un tipo, o ''. */
function catalogCode(entry, type) {
  if (!entry || !entry.types.includes(type)) return '';
  return entry.pila_codes?.[type] || (entry.types.length === 1 || SHAPE[type]?.(entry.pila_code || '') ? entry.pila_code || '' : '');
}

/**
 * Código PILA del proveedor `supplier` ({ pila_code, tax_id }) como `type`
 * ('eps' | 'afp' | 'ccf' | 'arl').
 */
function pilaCodeFor(supplier, type) {
  if (!supplier) return '';
  const own = String(supplier.pila_code || '').trim().toUpperCase();
  if (own && (SHAPE[type] ? SHAPE[type](own) : true)) return own;
  return catalogCode(catalogEntry(supplier.tax_id), type);
}

module.exports = { pilaCodeFor, catalogEntry, catalogCode };
