const logger = require('../config/logger');

/**
 * Sube un archivo buffer a Cloudinary y devuelve { url, public_id, resource_type }.
 * Si Cloudinary no está configurado, guarda en disco local (fallback dev).
 *
 * @param {Buffer} fileBuffer
 * @param {string} originalName
 * @param {string} folder
 * @param {{ mimeType?: string, waType?: string }} [options]
 */
const uploadToCloudinary = async (fileBuffer, originalName, folder, options = {}) => {
  const mimeType = String(options.mimeType || '').toLowerCase();
  const waType = options.waType || null;

  const useCloudinary =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;

  const resolveResourceType = () => {
    if (waType === 'image' || mimeType.startsWith('image/')) return 'image';
    // audio + video van como "video" en Cloudinary (soporta webm/ogg/mp3)
    if (waType === 'audio' || waType === 'video' || mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
      return 'video';
    }
    return 'raw';
  };

  if (useCloudinary) {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const resourceType = resolveResourceType();
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: resourceType,
          // Mantener extensión original para docs/audio
          use_filename: true,
          unique_filename: true,
        },
        (err, r) => (err ? reject(err) : resolve(r)),
      );
      stream.end(fileBuffer);
    });

    let url = result.secure_url;
    // Audios webm/ogg como video/upload no suenan en <audio>; forzar entrega mp3
    if ((waType === 'audio' || mimeType.startsWith('audio/')) && url.includes('/video/upload/')) {
      url = url.replace('/video/upload/', '/video/upload/f_mp3/');
    }

    return {
      url,
      public_id: result.public_id,
      resource_type: resourceType,
      bytes: result.bytes,
      format: result.format,
    };
  }

  // Fallback: disco local (solo desarrollo — en Vercel/prod no hay disco persistente)
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    const err = new Error('Cloudinary no configurado: no se pueden guardar media en producción');
    err.status = 500;
    throw err;
  }

  const path = require('path');
  const fs = require('fs');
  const safeFolder = String(folder || 'misc').replace(/[^a-zA-Z0-9/_-]/g, '_');
  const dir = path.join(__dirname, '../../uploads', safeFolder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safeName = String(originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = `${Date.now()}-${safeName}`;
  fs.writeFileSync(path.join(dir, filename), fileBuffer);

  const port = process.env.PORT || 5001;
  const base = (process.env.BACKEND_URL || `http://localhost:${port}`).replace(/\/$/, '').replace(/\/api$/, '');
  return {
    url: `${base}/uploads/${safeFolder}/${filename}`,
    public_id: filename,
    resource_type: 'local',
  };
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
        { mimeType: file.mimetype },
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

/** Reescribe URL Cloudinary de audio a mp3 reproducible en navegadores. */
function toPlayableAudioUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.includes('res.cloudinary.com') && url.includes('/video/upload/') && !url.includes('/f_mp3/')) {
    return url.replace('/video/upload/', '/video/upload/f_mp3/');
  }
  return url;
}

module.exports = { uploadToCloudinary, processSupportFiles, toPlayableAudioUrl };
