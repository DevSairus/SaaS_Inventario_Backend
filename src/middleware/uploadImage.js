const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Crear directorio de logos si no existe
const logoDir = path.join(__dirname, '../../uploads/logos');
if (!fs.existsSync(logoDir)) {
  fs.mkdirSync(logoDir, { recursive: true });
}

// Configuración de almacenamiento para logos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, logoDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'logo-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// Filtro de archivos (solo imágenes)
const imageFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        'Tipo de archivo no permitido. Solo se aceptan imágenes (jpg, png, webp)'
      ),
      false
    );
  }
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
