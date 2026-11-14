// backend/src/utils/signature.js
//
// Firma dibujada en pantalla (mouse, dedo o lápiz). El frontend manda un
// data URL PNG en base64 y se guarda tal cual junto al acta que se firma
// (corte de obra, entrega/devolución de herramientas, despacho, etc.).
// No hay repositorio de firmas: cada acta lleva la suya.
//
// Una sola regla de validación para todas las actas, para que no se
// desincronicen los topes ni el formato.

const SIGNATURE_MAX = 400 * 1024; // caracteres del data URL
const DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const PNG_MAGIC_B64 = 'iVBORw0KGgo'; // los 8 bytes de cabecera de todo PNG, en base64
const PREFIX = 'data:image/png;base64,';

const fail = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * Valida una firma opcional.
 * - vacía (undefined / null / '') → devuelve null
 * - válida → devuelve el mismo data URL
 * - inválida → lanza un error 400
 * Con { required: true } la firma vacía también es un error.
 */
function validateSignature(sig, { required = false, label = 'La firma' } = {}) {
  if (sig === undefined || sig === null || sig === '') {
    if (required) throw fail(`${label} es obligatoria`);
    return null;
  }
  if (typeof sig !== 'string' || !DATA_URL_RE.test(sig)) throw fail('Firma inválida');
  if (sig.length > SIGNATURE_MAX) throw fail('La firma es demasiado grande');
  if (!sig.slice(PREFIX.length).startsWith(PNG_MAGIC_B64)) throw fail('Firma inválida');
  return sig;
}

/** Buffer PNG de una firma ya guardada, o null si no hay / no se puede leer (para el PDF). */
function signatureBuffer(sig) {
  if (!sig || typeof sig !== 'string' || !sig.startsWith(PREFIX)) return null;
  try { return Buffer.from(sig.slice(PREFIX.length), 'base64'); } catch { return null; }
}

module.exports = { validateSignature, signatureBuffer, SIGNATURE_MAX };
