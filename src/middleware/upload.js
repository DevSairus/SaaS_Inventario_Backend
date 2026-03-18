const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Crear directorio de uploads si no existe
const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuración de almacenamiento
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'upload-' + uniqueSuffix + path.extname(file.originalname));
  },
});

// Filtro de archivos (solo Excel) — valida MIME y extensión
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-excel', // .xls
  ];
  const allowedExts = ['.xlsx', '.xls'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error('Tipo de archivo no permitido. Solo se aceptan archivos Excel (.xlsx, .xls)'), false);
  }
  if (!allowedExts.includes(ext)) {
    return cb(new Error('Extensión no permitida. Solo .xlsx o .xls'), false);
  }
  cb(null, true);
};

// Configurar multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

module.exports = upload;
