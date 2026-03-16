// middleware/uploadProductImage.js
// Usa memoryStorage — el archivo nunca toca el disco (compatible con Vercel/serverless)
const multer = require('multer');

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  allowed.includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Solo se aceptan imágenes (jpg, png, webp)'), false);
};

module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
});