// backend/src/services/whatsappService.js
//
// Integración WhatsApp sin servidor persistente (compatible con Vercel/serverless).
//
//  • sendText(phone, message)
//      Genera un enlace wa.me con el texto pre-cargado.
//      El frontend lo abre en pestaña nueva; el usuario presiona Enviar.
//
//  • sendDocument(phone, pdfBuffer, filename, caption)
//      Sube el PDF a Cloudinary (URL pública permanente) y genera un enlace
//      wa.me con el caption + la URL de descarga.
//
//  • getStatus() → siempre CONNECTED (no hay sesión que mantener).

const logger = require('../config/logger');

// ─── Cloudinary (lazy init) ────────────────────────────────────────────────
let cloudinary;
try {
  const { v2 } = require('cloudinary');
  cloudinary = v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure:     true,
  });
} catch {
  logger.warn('[WhatsApp] cloudinary no disponible — las subidas de PDF fallarán.');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Normaliza número colombiano → "573001234567" */
const formatColombianPhone = (phone) => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length >= 12) return digits;
  if (digits.startsWith('3') && digits.length === 10) return `57${digits}`;
  return `57${digits}`;
};

/** Construye un enlace wa.me con mensaje pre-cargado */
const buildWaLink = (phone, text) => {
  const formatted = formatColombianPhone(phone);
  return `https://wa.me/${formatted}?text=${encodeURIComponent(text)}`;
};

// ─── API Pública ───────────────────────────────────────────────────────────

/** Siempre CONNECTED — no hay sesión que gestionar */
const getStatus = () => ({ status: 'CONNECTED', qr: null });

/**
 * Genera un enlace wa.me con el texto pre-cargado.
 * No envía automáticamente; el usuario lo hace al abrir el enlace.
 */
const sendText = async (phone, message) => {
  const formatted = formatColombianPhone(phone);
  const waLink    = buildWaLink(phone, message);
  logger.info(`[WhatsApp] wa.me generado para ${formatted}`);
  return { success: true, waLink, phone: formatted };
};

/**
 * Sube el PDF a Cloudinary y genera un enlace wa.me con caption + URL.
 */
const sendDocument = async (phone, pdfBuffer, filename, caption) => {
  if (!cloudinary) {
    throw new Error('Cloudinary no configurado. Agrega CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET al .env');
  }

  const publicId = `facturas/${filename.replace('.pdf', '')}_${Date.now()}`;

  const pdfUrl = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', public_id: publicId, format: 'pdf' },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary: ${error.message}`));
        resolve(result.secure_url);
      }
    );
    stream.end(pdfBuffer);
  });

  logger.info(`[WhatsApp] PDF subido → ${pdfUrl}`);

  const message  = `${caption}\n\n📄 Descarga tu documento aquí:\n${pdfUrl}`;
  const waLink   = buildWaLink(phone, message);
  const formatted = formatColombianPhone(phone);

  logger.info(`[WhatsApp] wa.me con PDF generado para ${formatted}`);
  return { success: true, waLink, pdfUrl, phone: formatted };
};

// Stubs para compatibilidad con imports existentes
const initialize = async () => ({ success: true, status: 'CONNECTED' });
const disconnect = async () => {};

module.exports = {
  getStatus,
  initialize,
  disconnect,
  sendText,
  sendDocument,
  buildWaLink,
  formatColombianPhone,
};