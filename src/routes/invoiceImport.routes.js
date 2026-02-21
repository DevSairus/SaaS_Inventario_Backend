// backend/src/routes/invoiceImport.routes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { importInvoice, previewInvoice } = require('../controllers/invoiceImport.controller');

// Configurar multer para uploads en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos ZIP'));
    }
  }
});

/**
 * @route   POST /api/invoice-import/preview
 * @desc    Vista previa de factura electrónica
 * @access  Private
 */
router.post('/preview', upload.single('file'), previewInvoice);

/**
 * @route   POST /api/invoice-import/import
 * @desc    Importar factura electrónica
 * @access  Private
 */
router.post('/import', upload.single('file'), importInvoice);

module.exports = router;