// backend/src/middleware/uploadAttachment.js
// Adjuntos de documentos (routes/attachments.routes.js): en memoria, 10 MB.
const multer = require('multer');
const path = require('path');

const ALLOWED = {
  '.pdf': ['application/pdf'],
  '.xml': ['application/xml', 'text/xml'],
  '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.webp': ['image/webp'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc': ['application/msword'],
  '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  '.txt': ['text/plain'],
  '.zip': ['application/zip', 'application/x-zip-compressed'],
};

// Extensión permitida y tipo coherente con ella (algunos navegadores mandan
// application/octet-stream para XML o ZIP: se acepta si la extensión es válida).
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mimes = ALLOWED[ext];
  if (!mimes || !(mimes.includes(file.mimetype) || file.mimetype === 'application/octet-stream')) {
    return cb(Object.assign(new Error('Tipo de archivo no permitido. Usa PDF, XML, imagen, Excel, Word, CSV, TXT o ZIP.'), { statusCode: 400 }), false);
  }
  cb(null, true);
};

module.exports = multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
