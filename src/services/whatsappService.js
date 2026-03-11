// backend/src/services/whatsappService.js
const path = require('path');
const logger = require('../config/logger');

let client = null;
let sessionStatus = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | QR_READY | CONNECTED
let currentQR = null;

const SESSION_FOLDER = path.join(__dirname, '../../../.wpp-sessions');

const getStatus = () => ({ status: sessionStatus, qr: currentQR });

const initialize = async () => {
  if (sessionStatus === 'CONNECTED') {
    return { success: true, status: 'CONNECTED' };
  }

  // Lazy-load wppconnect para evitar crash al iniciar si no está instalado
  let wppconnect;
  try {
    wppconnect = require('@wppconnect-team/wppconnect');
  } catch {
    throw new Error('wppconnect no instalado. Ejecuta: npm install @wppconnect-team/wppconnect');
  }

  sessionStatus = 'CONNECTING';
  currentQR = null;
  logger.info('[WhatsApp] Iniciando sesión WPPConnect...');

  try {
    client = await wppconnect.create({
      session: 'inventario-wpp',
      folderNameToken: SESSION_FOLDER,
      headless: true,
      logQR: false,
      disableWelcome: true,
      updatesLog: false,
      autoClose: 0,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
      catchQR: (base64Qr) => {
        currentQR = base64Qr;
        sessionStatus = 'QR_READY';
        logger.info('[WhatsApp] QR listo — esperando escaneo...');
      },
      statusFind: (statusSession) => {
        logger.info('[WhatsApp] Estado sesión:', statusSession);
        if (statusSession === 'isLogged' || statusSession === 'inChat') {
          sessionStatus = 'CONNECTED';
          currentQR = null;
          logger.info('[WhatsApp] ✅ Conectado correctamente');
        } else if (statusSession === 'notLogged' || statusSession === 'browserClose') {
          sessionStatus = 'DISCONNECTED';
          currentQR = null;
        }
      },
    });

    sessionStatus = 'CONNECTED';
    currentQR = null;
    logger.info('[WhatsApp] ✅ Cliente WPPConnect inicializado');
    return { success: true, status: 'CONNECTED' };
  } catch (error) {
    sessionStatus = 'DISCONNECTED';
    currentQR = null;
    logger.error('[WhatsApp] Error iniciando:', error.message);
    throw error;
  }
};

const disconnect = async () => {
  if (client) {
    try {
      await client.logout();
    } catch { /* ignore */ }
    client = null;
  }
  sessionStatus = 'DISCONNECTED';
  currentQR = null;
  logger.info('[WhatsApp] Sesión desconectada');
};

/**
 * Envía un mensaje de texto al número de WhatsApp del cliente.
 * @param {string} phone    Número colombiano: "3001234567" o "+573001234567"
 * @param {string} message  Texto del mensaje (soporta formato WhatsApp: *negrita*, _cursiva_)
 */
const sendText = async (phone, message) => {
  if (!client || sessionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp no está conectado. Escanea el código QR en Configuración → WhatsApp.');
  }

  const formattedPhone = formatColombianPhone(phone);
  const chatId = `${formattedPhone}@c.us`;

  await client.sendText(chatId, message);
  logger.info(`[WhatsApp] Mensaje de texto enviado a ${formattedPhone}`);
  return { success: true, phone: formattedPhone };
};

/**
 * Envía un PDF (Buffer) al número de WhatsApp del cliente.
 * @param {string} phone      Número colombiano: "3001234567" o "+573001234567"
 * @param {Buffer} pdfBuffer
 * @param {string} filename   ej: "FACTURA-F001.pdf"
 * @param {string} caption    Mensaje de texto junto al documento
 */
const sendDocument = async (phone, pdfBuffer, filename, caption) => {
  if (!client || sessionStatus !== 'CONNECTED') {
    throw new Error('WhatsApp no está conectado. Escanea el código QR en Configuración → WhatsApp.');
  }

  const formattedPhone = formatColombianPhone(phone);
  const chatId = `${formattedPhone}@c.us`;

  // wppconnect.sendFile acepta base64 o Buffer
  const base64Data = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;

  await client.sendFile(chatId, base64Data, filename, caption);
  logger.info(`[WhatsApp] PDF enviado a ${formattedPhone} — ${filename}`);
  return { success: true, phone: formattedPhone };
};

/**
 * Normaliza número colombiano a formato internacional sin +
 * "3001234567" → "573001234567"
 */
const formatColombianPhone = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('57')) return digits;
  if (digits.startsWith('3') && digits.length === 10) return `57${digits}`;
  return `57${digits}`;
};

module.exports = { initialize, disconnect, getStatus, sendText, sendDocument };