const multer = require('multer');
const path = require('path');

const storage = multer.memoryStorage();

const allowedMimes = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr',
  'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/mp3',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'text/plain',
  'application/octet-stream',
];

const allowedExts = [
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
  '.mp4', '.3gp', '.mov', '.webm',
  '.ogg', '.opus', '.mp3', '.m4a', '.aac', '.amr', '.wav',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.zip',
];

const uploadWhatsAppMedia = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB — límite típico Cloud API docs
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      return cb(null, true);
    }
    return cb(new Error('Tipo de archivo no permitido para WhatsApp'), false);
  },
});

function guessWaType(mimetype = '', filename = '') {
  const mime = String(mimetype).toLowerCase();
  const ext = path.extname(filename || '').toLowerCase();
  if (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['.mp4', '.3gp', '.mov', '.webm'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['.ogg', '.opus', '.mp3', '.m4a', '.aac', '.amr', '.wav', '.webm'].includes(ext)) {
    // webm puede ser video; si mime es audio/webm → audio
    if (ext === '.webm' && mime.startsWith('video/')) return 'video';
    return 'audio';
  }
  return 'document';
}

module.exports = { uploadWhatsAppMedia, guessWaType };
