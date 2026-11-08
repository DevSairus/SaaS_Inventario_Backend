// backend/src/services/dian/supplierDianReadiness.js
/**
 * Gate de completitud de datos DIAN del proveedor/vendedor, antes de
 * generar un Documento Soporte. Mismo criterio y forma que
 * customerDianReadiness.js — corta ANTES de consumir un consecutivo DIAN
 * si falta un dato requerido para armar el AccountingSupplierParty, en vez
 * de transmitir con el fallback hardcodeado de dianKitAdapter (Bogotá
 * D.C./Cundinamarca).
 *
 * Sirve tanto para un Supplier real (compras y gastos con proveedor
 * asociado) como para el vendedor capturado ad-hoc en un gasto sin
 * Supplier (mismo shape de campos, ver dian.controller.js).
 */

const REQUIRED_FIELDS = [
  { key: 'tax_id', label: 'número de identificación del proveedor' },
  { key: 'person_type', label: 'tipo de persona del proveedor (natural/jurídica)' },
  { key: 'city_code', label: 'ciudad del proveedor (código DIVIPOLA)' },
];
// Vendedor del exterior (no residente): la ciudad va en texto libre y no hay
// código DIVIPOLA (Anexo Técnico DS, reglas DSAJ08b/DSAJ10 con CustomizationID 11).
const FOREIGN_REQUIRED_FIELDS = [
  REQUIRED_FIELDS[0],
  REQUIRED_FIELDS[1],
  { key: 'city', label: 'ciudad del proveedor' },
];

const isForeign = (s) => Boolean(s?.country_code) && String(s.country_code).toUpperCase() !== 'CO';

class DianSupplierIncompleteError extends Error {
  constructor(missingFields, supplierId) {
    const labels = missingFields.map(f => f.label).join(', ');
    super(`No se puede generar el Documento Soporte: falta ${labels}. Complétalo e intenta de nuevo.`);
    this.name = 'DianSupplierIncompleteError';
    this.code = 'DIAN_SUPPLIER_INCOMPLETE';
    this.supplierId = supplierId || null;
    this.missingFields = missingFields.map(f => f.key);
  }
}

/**
 * @param {object} supplierOrAdHoc - Supplier (tax_id/person_type/city_code
 *   nativos del modelo) o el objeto ad-hoc capturado en el modal de
 *   generación de un gasto sin proveedor (mismas 3 claves).
 */
function checkReadiness(supplierOrAdHoc) {
  if (!supplierOrAdHoc) return { ready: false, missing: REQUIRED_FIELDS };
  const fields = isForeign(supplierOrAdHoc) ? FOREIGN_REQUIRED_FIELDS : REQUIRED_FIELDS;
  const missing = fields.filter(f => !String(supplierOrAdHoc[f.key] ?? '').trim());
  return { ready: missing.length === 0, missing };
}

function assertReadiness(supplierOrAdHoc) {
  const { ready, missing } = checkReadiness(supplierOrAdHoc);
  if (!ready) {
    throw new DianSupplierIncompleteError(missing, supplierOrAdHoc?.id);
  }
}

module.exports = { checkReadiness, assertReadiness, DianSupplierIncompleteError, REQUIRED_FIELDS, isForeign };
