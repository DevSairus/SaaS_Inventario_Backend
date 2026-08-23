// backend/src/services/dian/customerDianReadiness.js
/**
 * Gate de completitud de datos DIAN del comprador, antes de facturar.
 *
 * Contexto: los formularios de creación rápida de clientes (OT, Ventas,
 * webhook de WhatsApp/Meta) no piden ciudad DIVIPOLA — por diseño, para no
 * frenar el flujo de "llegó un cliente nuevo, arranco la OT ya". El
 * Customer model (ver hook beforeValidate en models/sales/Customer.js)
 * autocompleta city_code con la ciudad configurada del tenant cuando no
 * llega, así que en la mayoría de los casos este gate nunca dispara.
 *
 * Pero sigue existiendo un camino para llegar a facturar sin esos datos:
 * clientes creados antes de la migración 2026082302 (sin city_code ni
 * document_type), o un tenant que todavía no configuró su propia ciudad en
 * DianConfigPage (con lo cual tampoco hay de dónde autocompletar). Antes de
 * este gate, esos casos se enviaban igual a la DIAN cayendo en el fallback
 * hardcodeado de dianKitAdapter (Bogotá D.C./Cundinamarca, NIT) — el
 * hallazgo original de la auditoría. Este gate corta ahí: si falta el dato,
 * NO se envía (y no se consume un consecutivo DIAN en el intento), en vez
 * de transmitir con datos incorrectos.
 *
 * Se valida contra los campos ya denormalizados en Sale/nota
 * (customer_city_code, customer_document_type) porque son exactamente los
 * campos que dianKitAdapter usa como fuente real — si estos están, el
 * fallback hardcodeado nunca se alcanza.
 */

const REQUIRED_FIELDS = [
  { key: 'customer_city_code', label: 'ciudad del cliente (código DIVIPOLA)' },
  { key: 'customer_document_type', label: 'tipo de identificación del cliente' },
];

class DianCustomerIncompleteError extends Error {
  constructor(missingFields, customerId) {
    const labels = missingFields.map(f => f.label).join(', ');
    super(`No se puede facturar electrónicamente: falta ${labels} en la ficha del cliente. Complétala e intenta de nuevo.`);
    this.name = 'DianCustomerIncompleteError';
    this.code = 'DIAN_CUSTOMER_INCOMPLETE';
    this.customerId = customerId || null;
    this.missingFields = missingFields.map(f => f.key);
  }
}

/**
 * @param {object} saleOrNote - Sale o nota (customer_city_code y
 *   customer_document_type ya denormalizados sobre el registro).
 * @returns {{ ready: boolean, missing: Array<{key: string, label: string}> }}
 */
function checkReadiness(saleOrNote) {
  const missing = REQUIRED_FIELDS.filter(f => !saleOrNote?.[f.key]);
  return { ready: missing.length === 0, missing };
}

/**
 * Lanza DianCustomerIncompleteError si faltan datos. Se llama antes de
 * consumir el consecutivo DIAN, para no quemar numeración en un intento que
 * de todas formas no se puede transmitir bien.
 */
function assertReadiness(saleOrNote) {
  const { ready, missing } = checkReadiness(saleOrNote);
  if (!ready) {
    throw new DianCustomerIncompleteError(missing, saleOrNote?.customer_id);
  }
}

module.exports = { checkReadiness, assertReadiness, DianCustomerIncompleteError, REQUIRED_FIELDS };
