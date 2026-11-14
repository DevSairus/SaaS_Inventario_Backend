// backend/src/utils/emailRecipients.js
//
// Listas de destinatarios de correo (factura a múltiples correos).
// Acepta un arreglo o un texto separado por comas, punto y coma, espacios o
// saltos de línea; recorta, descarta vacíos, quita duplicados sin distinguir
// mayúsculas (conserva la primera escritura) y valida el formato.
'use strict';

const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[^\s@,;<>()[\]\\]+\.[^\s@,;<>()[\]\\]{2,}$/;
const MAX_ADDITIONAL_EMAILS = 10;

function toTokens(input) {
  if (input === undefined || input === null || input === '') return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[,;\s]+/);
  return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
}

/**
 * @returns {{ emails: string[], invalid: string[] }}
 */
function normalizeEmailList(input) {
  const seen = new Set();
  const emails = [];
  const invalid = [];
  for (const token of toTokens(input)) {
    if (!EMAIL_RE.test(token) || token.length > 255) {
      invalid.push(token);
      continue;
    }
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(token);
  }
  return { emails, invalid };
}

/**
 * Valida una lista ya normalizada. Devuelve el mensaje de error o null.
 */
function validateEmailList(input, { max = MAX_ADDITIONAL_EMAILS } = {}) {
  const { emails, invalid } = normalizeEmailList(input);
  if (invalid.length > 0) return `Correo(s) no válido(s): ${invalid.join(', ')}`;
  if (emails.length > max) return `Máximo ${max} correos adicionales`;
  return null;
}

/**
 * Destinatarios finales de una factura: el correo principal del comprador más
 * la lista adicional (la propia de la factura si existe; si no, la del cliente).
 */
function resolveInvoiceRecipients({ primary, saleOverride, customerAdditional }) {
  const extra = Array.isArray(saleOverride) ? saleOverride : (Array.isArray(customerAdditional) ? customerAdditional : []);
  return normalizeEmailList([primary, ...extra]).emails;
}

module.exports = { normalizeEmailList, validateEmailList, resolveInvoiceRecipients, MAX_ADDITIONAL_EMAILS };
