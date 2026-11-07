// backend/src/services/attachments/attachmentStorage.js
//
// Almacenamiento privado de adjuntos (mismo patrón que
// services/legal/consentDocumentStorage.js): facturas, XML, soportes de pago y
// fotos tienen datos de terceros, así que NUNCA quedan en una URL pública.
//   - Cloudinary: type 'authenticated'; se lee con un enlace firmado que
//     vence y el backend lo entrega al usuario (no se expone el enlace).
//   - Sin Cloudinary (desarrollo local): backend/private_uploads/attachments,
//     fuera de /uploads (que server.js sirve como estático).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCAL_DIR = path.join(__dirname, '../../../private_uploads/attachments');
const LINK_TTL_SECONDS = 5 * 60;
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

// Valores de ejemplo del .env ("your_cloudinary_api_key") cuentan como sin
// configurar: en desarrollo local se guarda en disco privado.
const configured = (v) => Boolean(v) && !/^your[_-]/i.test(v);
const useCloudinary = () => configured(process.env.CLOUDINARY_CLOUD_NAME)
  && configured(process.env.CLOUDINARY_API_KEY) && configured(process.env.CLOUDINARY_API_SECRET);

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

const safeExt = (name) => path.extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);

/** Guarda el archivo y devuelve los campos de almacenamiento del Attachment. */
async function storeAttachment({ tenantId, file }) {
  const id = crypto.randomUUID();
  const meta = {
    file_name: String(file.originalname || 'archivo').slice(0, 255),
    mime_type: file.mimetype || null,
    size_bytes: file.size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  };

  if (useCloudinary()) {
    const cloudinary = getCloudinary();
    // Imágenes como 'image'; lo demás (PDF, XML, Excel) como 'raw': Cloudinary
    // restringe por defecto la entrega de PDF como imagen en cuentas nuevas.
    const isImage = IMAGE_MIMES.includes(file.mimetype);
    const ext = safeExt(file.originalname);
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `attachments/${tenantId}`,
          // raw conserva la extensión solo si va en el public_id.
          public_id: isImage ? id : `${id}${ext}`,
          type: 'authenticated',
          resource_type: isImage ? 'image' : 'raw',
        },
        (err, r) => (err ? reject(err) : resolve(r))
      );
      stream.end(file.buffer);
    });
    return { ...meta, storage: 'cloudinary', storage_key: result.public_id, resource_type: result.resource_type, format: result.format || null };
  }

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const name = `${tenantId}-${id}${safeExt(file.originalname)}`;
  fs.writeFileSync(path.join(LOCAL_DIR, name), file.buffer);
  return { ...meta, storage: 'local', storage_key: name, resource_type: null, format: null };
}

/** Contenido del archivo: { buffer } (descargado de Cloudinary) o { localPath }. */
async function readAttachment(att) {
  if (att.storage === 'cloudinary') {
    const cloudinary = getCloudinary();
    const url = cloudinary.utils.private_download_url(att.storage_key, att.resource_type === 'raw' ? '' : (att.format || ''), {
      resource_type: att.resource_type || 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
    });
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error('No se pudo leer el archivo'), { statusCode: 502 });
    return { buffer: Buffer.from(await res.arrayBuffer()) };
  }
  const localPath = path.join(LOCAL_DIR, path.basename(att.storage_key || ''));
  if (!fs.existsSync(localPath)) throw Object.assign(new Error('El archivo ya no existe'), { statusCode: 404 });
  return { localPath };
}

async function removeAttachment(att) {
  try {
    if (att.storage === 'cloudinary') {
      await getCloudinary().uploader.destroy(att.storage_key, { type: 'authenticated', resource_type: att.resource_type || 'image' });
    } else {
      fs.rmSync(path.join(LOCAL_DIR, path.basename(att.storage_key || '')), { force: true });
    }
  } catch (err) {
    // El registro se borra igual; un archivo huérfano no expone nada (es privado).
    console.error('[attachments] No se pudo borrar el archivo:', err.message);
  }
}

module.exports = { storeAttachment, readAttachment, removeAttachment };
