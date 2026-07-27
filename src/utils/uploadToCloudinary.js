const logger = require('../config/logger');

/**
 * Sube un archivo buffer a Cloudinary y devuelve { url, public_id }.
 * Si Cloudinary no está configurado, guarda en disco local (fallback dev).
 */
const uploadToCloudinary = async (fileBuffer, originalName, folder) => {
  const useCloudinary =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;

  if (useCloudinary) {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'auto' },
        (err, r) => (err ? reject(err) : resolve(r)),
      );
      stream.end(fileBuffer);
    });
    return { url: result.secure_url, public_id: result.public_id };
  }

  // Fallback: disco local
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(__dirname, '../../uploads/support');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `support-${Date.now()}-${originalName}`;
  fs.writeFileSync(path.join(dir, filename), fileBuffer);
  return { url: `/uploads/support/${filename}`, public_id: filename };
};

/**
 * Procesa req.files y devuelve un array de registros listos para insertar
 * en support_ticket_attachments.
 */
const processSupportFiles = async (files, ticketId, messageId, tenantId) => {
  if (!files || files.length === 0) return [];

  const attachments = [];
  for (const file of files) {
    try {
      const { url } = await uploadToCloudinary(
        file.buffer,
        file.originalname,
        `support/${tenantId}/${ticketId}`,
      );
      attachments.push({
        ticket_id: ticketId,
        message_id: messageId,
        file_url: url,
        file_name: file.originalname,
        mime_type: file.mimetype,
      });
    } catch (err) {
      logger.error('Error subiendo adjunto a Cloudinary:', err);
    }
  }
  return attachments;
};

module.exports = { uploadToCloudinary, processSupportFiles };
