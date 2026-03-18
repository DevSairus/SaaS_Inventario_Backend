const multer = require('multer');
const path = require('path');

// Memory storage — Vercel es stateless, no hay disco persistente.
// El buffer se pasa al controlador que sube a Cloudinary.
const storage = multer.memoryStorage();

// Filtro de archivos (solo imágenes) — valida MIME y extensión
const imageFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const allowedExts  = ['.jpg', '.jpeg', '.png', '.webp'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error('Tipo de archivo no permitido. Solo se aceptan imágenes (jpg, png, webp)'), false);
  }
  if (!allowedExts.includes(ext)) {
    return cb(new Error('Extensión de archivo no permitida. Solo .jpg .jpeg .png .webp'), false);
  }
  cb(null, true);
};

// Configurar multer para imágenes
const uploadImage = multer({
  storage: storage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
});

module.exports = uploadImage;
