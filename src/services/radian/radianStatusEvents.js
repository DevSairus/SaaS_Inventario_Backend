// backend/src/services/radian/radianStatusEvents.js
/**
 * Lectura de la respuesta de GetStatusEvent (Anexo FE 1.9 §7.17): la DIAN
 * devuelve, en XmlBase64Bytes, un ApplicationResponse con los eventos
 * registrados sobre una factura (030 acuse, 032 recibo del bien, 031
 * reclamo, 033 aceptación expresa, 034 aceptación tácita...).
 *
 * ⚠️ El Anexo muestra el sobre SOAP pero NO el contenido de ese
 * ApplicationResponse. El parser es tolerante a dos formas razonables:
 *   a) un ApplicationResponse con un cac:DocumentResponse por evento, cada
 *      uno con Response/ResponseCode y DocumentReference (ID = número del
 *      evento, UUID = CUDE, IssueDate/IssueTime o EffectiveDate);
 *   b) ApplicationResponse de eventos completos anidados (cada uno con su
 *      cbc:ID, cbc:UUID e IssueDate propios).
 * Un UUID igual al CUFE de la factura no es un CUDE de evento: se descarta.
 * Hasta verificarlo con una respuesta real, quien lo llama solo registra un
 * evento cuando trae número, CUDE y fecha completos, y devuelve un
 * fragmento del XML para diagnóstico si no reconoce ninguno.
 */
'use strict';

const { DOMParser } = require('@xmldom/xmldom');

const RADIAN_CODES = new Set(['030', '031', '032', '033', '034']);

const children = (node) => Array.from(node?.childNodes || []).filter((n) => n.nodeType === 1);
const child = (node, name) => children(node).find((n) => n.localName === name) || null;
const text = (node) => (node?.textContent || '').trim();
const descendants = (node, name) => (node ? Array.from(node.getElementsByTagNameNS('*', name)) : []);

// 'YYYY-MM-DD' + 'HH:MM:SS(-05:00)' → ISO con zona (Colombia si no trae).
function toIsoDateTime(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const t = String(time || '').trim();
  const hhmmss = (t.match(/^\d{2}:\d{2}(:\d{2})?/) || [])[0] || '00:00:00';
  const tz = (t.match(/(Z|[+-]\d{2}:\d{2})$/) || [])[1] || '-05:00';
  return `${date}T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}${tz}`;
}

const isCude = (v) => /^[0-9a-f]{96}$/i.test(v || '');

/**
 * @param {string} xml - ApplicationResponse decodificado de XmlBase64Bytes
 * @param {string} invoiceCufe - CUFE de la factura consultada
 * @returns {Array<{ code: string, description: string, number: string|null, cude: string|null, issuedAt: string|null }>}
 */
function parseStatusEventXml(xml, invoiceCufe) {
  if (!xml) return [];
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(xml), 'text/xml');
  } catch {
    return [];
  }
  const cufe = String(invoiceCufe || '').toLowerCase();
  const events = [];

  for (const dr of descendants(doc, 'DocumentResponse')) {
    const response = child(dr, 'Response');
    const code = text(child(response, 'ResponseCode'));
    if (!RADIAN_CODES.has(code)) continue;
    const ref = child(dr, 'DocumentReference');

    // Forma (b): el DocumentResponse vive dentro de un ApplicationResponse
    // propio del evento — su cbc:ID/UUID/IssueDate son los del evento.
    const ar = dr.parentNode && dr.parentNode.localName === 'ApplicationResponse' ? dr.parentNode : null;
    const arIsEvent = ar && ar !== doc.documentElement;

    let number = text(child(ref, 'ID')) || null;
    let cude = text(child(ref, 'UUID')).toLowerCase() || null;
    let issuedAt = toIsoDateTime(text(child(ref, 'IssueDate')), text(child(ref, 'IssueTime')))
      || toIsoDateTime(text(child(response, 'EffectiveDate')), text(child(response, 'EffectiveTime')));

    if (arIsEvent) {
      number = text(child(ar, 'ID')) || number;
      cude = text(child(ar, 'UUID')).toLowerCase() || cude;
      issuedAt = toIsoDateTime(text(child(ar, 'IssueDate')), text(child(ar, 'IssueTime'))) || issuedAt;
    }
    // La referencia a la propia factura no identifica el evento.
    if (cude === cufe) { cude = null; number = arIsEvent ? number : null; }

    events.push({
      code,
      description: text(child(response, 'Description')),
      number,
      cude: isCude(cude) ? cude : null,
      issuedAt,
    });
  }
  return events;
}

module.exports = { parseStatusEventXml };
