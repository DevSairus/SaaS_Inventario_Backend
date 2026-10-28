// backend/src/services/legal/consentDocumentStorage.js
//
// Guarda el escaneo del formato de autorización firmado en papel. Tiene datos
// personales y una firma, así que NUNCA queda en una URL pública:
//   - Cloudinary: type 'authenticated'; solo se entrega con un enlace
//     firmado que vence (private_download_url), a pedido del personal.
//   - Sin Cloudinary (desarrollo local): backend/private_uploads/consents,
//     fuera de /uploads (que server.js sirve como estático).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCAL_DIR = path.join(__dirname, '../../../private_uploads/consents');
const LINK_TTL_SECONDS = 10 * 60;

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const useCloudinary = () => Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);

function getCloudinary() {
  const cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  return cloudinary;
}

async function storeSignedDocument({ tenantId, consentId, file }) {
  const meta = {
    filename: file.originalname,
    mime: file.mimetype,
    size: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    uploaded_at: new Date().toISOString(),
  };

  if (useCloudinary()) {
    const cloudinary = getCloudinary();
    const isPdf = file.mimetype === 'application/pdf';
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `consents/${tenantId}`,
          public_id: consentId,
          type: 'authenticated',
          // Los PDF como 'raw': Cloudinary restringe por defecto la entrega
          // de PDF como imagen en cuentas nuevas.
          resource_type: isPdf ? 'raw' : 'image',
          overwrite: true,
        },
        (err, r) => (err ? reject(err) : resolve(r))
      );
      stream.end(file.buffer);
    });
    return {
      ...meta,
      storage: 'cloudinary',
      public_id: result.public_id,
      resource_type: result.resource_type,
      format: result.format || (isPdf ? 'pdf' : null),
    };
  }

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
  const name = `${tenantId}-${consentId}${ext}`;
  fs.writeFileSync(path.join(LOCAL_DIR, name), file.buffer);
  return { ...meta, storage: 'local', path: name };
}

/**
 * Cloudinary → { url } temporal. Local → { localPath } para enviar el archivo.
 */
function resolveSignedDocument(doc) {
  if (!doc) return null;
  if (doc.storage === 'cloudinary') {
    const cloudinary = getCloudinary();
    const url = cloudinary.utils.private_download_url(doc.public_id, doc.format || '', {
      resource_type: doc.resource_type || 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
    });
    return { url };
  }
  const localPath = path.join(LOCAL_DIR, path.basename(doc.path || ''));
  return fs.existsSync(localPath) ? { localPath } : null;
}

module.exports = { ALLOWED_MIMES, storeSignedDocument, resolveSignedDocument };
