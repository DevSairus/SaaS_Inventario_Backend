// backend/src/services/ocr/ocrClient.js
//
// Cliente del servicio OCR propio de Pitbox (carpeta ocr-service/: FastAPI +
// Tesseract en español + pdfplumber, mismo código que el OCR de DocuCore),
// desplegado en Railway junto al backend. Se le envía el archivo en base64
// (/ocr/extract-base64) con la clave interna.
//
// Variables de entorno:
//   OCR_SERVICE_URL   → p. ej. https://pitbox-ocr.up.railway.app (o http://127.0.0.1:8010 en local)
//   OCR_INTERNAL_KEY  → igual a OCR_INTERNAL_KEY del servicio
//   OCR_TIMEOUT_MS    → opcional, 100000 por defecto (el servicio corta a los 90 s)

const logger = require('../../config/logger');

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function isConfigured() {
  return Boolean(process.env.OCR_SERVICE_URL && process.env.OCR_INTERNAL_KEY);
}

/**
 * Extrae el texto de un PDF o imagen.
 * @param {{ buffer: Buffer, filename: string, mimeType: string, documentId?: string }} file
 * @returns {Promise<{ text: string, method: string, quality: number, pages: number, warnings: string[] }>}
 */
async function extractText({ buffer, filename, mimeType, documentId = 'pitbox' }) {
  if (!isConfigured()) throw httpError(503, 'La lectura de facturas no está disponible en este momento: ingresa los datos a mano');
  const url = `${process.env.OCR_SERVICE_URL.replace(/\/$/, '')}/ocr/extract-base64`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.OCR_INTERNAL_KEY },
      body: JSON.stringify({ document_id: String(documentId).slice(0, 100), filename: String(filename || 'archivo').slice(0, 255), content_base64: buffer.toString('base64'), mime_type: mimeType }),
      signal: AbortSignal.timeout(Number(process.env.OCR_TIMEOUT_MS) || 100000),
    });
  } catch (error) {
    logger.warn(`[ocr] Servicio OCR no respondió: ${error.message}`);
    throw httpError(502, 'No se pudo leer la factura (el servicio de lectura no respondió). Ingresa los datos a mano.');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 413) throw httpError(413, 'El archivo es demasiado grande');
  if (res.status === 503) throw httpError(503, 'El servicio de lectura está ocupado: intenta de nuevo en un momento');
  if (!res.ok || body.success === false) {
    logger.warn(`[ocr] HTTP ${res.status}: ${body.detail || body.method || ''} ${(body.warnings || []).join(' | ')}`);
    throw httpError(422, 'No se pudo leer el archivo. Prueba con una foto más nítida o un PDF.');
  }
  return {
    text: body.text || '',
    method: body.method,
    quality: body.quality_score,
    pages: body.page_count,
    warnings: body.warnings || [],
  };
}

module.exports = { extractText, isConfigured };
