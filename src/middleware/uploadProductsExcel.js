// middleware/uploadProductsExcel.js
// Usa memoryStorage — el archivo nunca toca el disco (compatible con Vercel/serverless)
const multer = require('multer');

const ALLOWED_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
];
const ALLOWED_EXTS = ['.xlsx', '.xls'];

const fileFilter = (req, file, cb) => {
  const ext = file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase();
  if (ALLOWED_MIMES.includes(file.mimetype) || ALLOWED_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se aceptan archivos Excel (.xlsx, .xls)'), false);
  }
};

module.exports = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});
