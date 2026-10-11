// backend/src/utils/returnLabels.js
// Etiquetas de los motivos de devolución (mismos códigos que el frontend,
// frontend/src/utils/returnLabels.js) para textos que ve el usuario, como
// las notas del movimiento de inventario.

'use strict';

const CUSTOMER_RETURN_REASONS = {
  defective: 'Producto Defectuoso',
  wrong_item: 'Producto Incorrecto',
  changed_mind: 'Cliente Cambió de Opinión',
  // Motivos de "Anular venta" (VoidSaleModal).
  customer_request: 'Solicitud del cliente',
  wrong_product: 'Producto equivocado',
  other: 'Otro',
};

const SUPPLIER_RETURN_REASONS = {
  defective: 'Producto Defectuoso',
  incorrect: 'Producto Incorrecto',
  excess: 'Exceso de Inventario',
  damaged: 'Dañado en Tránsito',
  other: 'Otro',
};

const reasonLabel = (map, code) => (code ? map[code] || code : '');

module.exports = { CUSTOMER_RETURN_REASONS, SUPPLIER_RETURN_REASONS, reasonLabel };
