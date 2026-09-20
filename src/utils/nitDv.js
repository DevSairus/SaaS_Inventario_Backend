// backend/src/utils/nitDv.js
//
// Dígito de verificación del NIT colombiano (algoritmo módulo 11 de la
// DIAN). Es aritmética pública y estable (no una regla tributaria sujeta a
// cambio de resolución), así que a diferencia de los códigos de concepto de
// Exógena, aquí sí es seguro calcularlo en vez de pedírselo al usuario.
//
// Usado por el Formato 1003/1005/1006 de Exógena (atributo `dv`, opcional
// pero recomendado "si se conoce" para terceros con tipo de documento 31).

const WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/**
 * @param {string} nit - solo dígitos (sin DV, sin guiones/puntos).
 * @returns {string|null} El dígito de verificación (0-9), o null si `nit`
 *   no es un NIT numérico válido.
 */
function calculateNitDv(nit) {
  if (!nit) return null;
  const digits = String(nit).replace(/\D/g, '');
  if (!digits) return null;

  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    const weight = WEIGHTS[i] || 0;
    sum += digit * weight;
  }

  const remainder = sum % 11;
  const dv = remainder > 1 ? 11 - remainder : remainder;
  return String(dv);
}

module.exports = { calculateNitDv };
