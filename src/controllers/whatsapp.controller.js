// backend/src/controllers/whatsapp.controller.js

const logger = require('../config/logger');

/** GET /api/whatsapp/status — siempre CONNECTED en modo wa.me */
const getStatus = (req, res) => {
  res.json({ success: true, status: 'CONNECTED', qr: null });
};

/** POST /api/whatsapp/connect — no-op */
const connect = async (req, res) => {
  res.json({ success: true, status: 'CONNECTED', message: 'Modo wa.me activo — no requiere conexión.' });
};

/** POST /api/whatsapp/disconnect — no-op */
const disconnect = async (req, res) => {
  res.json({ success: true, message: 'Modo wa.me — no hay sesión que cerrar.' });
};

/**
 * GET /api/whatsapp/test-cloudinary
 * Verifica la conexión con Cloudinary subiendo un PDF de prueba mínimo
 * y eliminándolo inmediatamente. Responde con diagnóstico detallado.
 */
const testCloudinary = async (req, res) => {
  const diagnosis = {
    env: {
      CLOUDINARY_CLOUD_NAME: !!process.env.CLOUDINARY_CLOUD_NAME,
      CLOUDINARY_API_KEY:    !!process.env.CLOUDINARY_API_KEY,
      CLOUDINARY_API_SECRET: !!process.env.CLOUDINARY_API_SECRET,
      cloud_name_value:      process.env.CLOUDINARY_CLOUD_NAME || '(no definido)',
    },
    upload: null,
    error:  null,
  };

  // Validar vars antes de intentar
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return res.status(400).json({
      success: false,
      message: 'Faltan variables de entorno de Cloudinary.',
      diagnosis,
    });
  }

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
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: 'cloudinary npm no instalado. Ejecuta: npm install cloudinary',
      diagnosis,
    });
  }

  // PDF mínimo válido de 1 página para la prueba
  const minimalPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj ' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
    '3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n' +
    '0000000058 00000 n\n0000000115 00000 n\n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF'
  );

  try {
    const publicId = `test/cloudinary-ping-${Date.now()}`;

    // Subir
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: publicId, format: 'pdf', type: 'upload', access_mode: 'public' },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(minimalPdf);
    });

    diagnosis.upload = {
      public_id:  uploadResult.public_id,
      secure_url: uploadResult.secure_url,
      bytes:      uploadResult.bytes,
      created_at: uploadResult.created_at,
    };

    // Eliminar inmediatamente (no dejar basura)
    await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });

    logger.info('[Cloudinary] Test OK — subida y eliminación exitosas');
    res.json({
      success: true,
      message: '✅ Cloudinary conectado correctamente. El PDF de prueba fue subido y eliminado.',
      diagnosis,
    });
  } catch (error) {
    diagnosis.error = error.message;
    logger.error('[Cloudinary] Test FAIL:', error.message);
    res.status(500).json({
      success: false,
      message: `❌ Error conectando con Cloudinary: ${error.message}`,
      diagnosis,
    });
  }
};

module.exports = { getStatus, connect, disconnect, testCloudinary };