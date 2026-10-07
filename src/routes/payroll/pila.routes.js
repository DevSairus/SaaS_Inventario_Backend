const express = require('express');
const multer = require('multer');
const ctrl = require('../../controllers/payroll/pila.controller');

// Planilla anterior (TXT o Excel) en memoria -- ver pilaImport.service.js.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(txt|xlsx)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Solo se permiten archivos .txt o .xlsx'));
  },
});

const router = express.Router();

// Planilla PILA del mes -- ver services/payroll/pila/. Autenticación,
// tenant y módulo aplicados en server.js; roles en el controller.
router.get('/preview', ctrl.preview);
router.get('/download', ctrl.download);
router.post('/import/analyze', (req, res, next) => upload.single('file')(req, res, (err) => (
  err ? res.status(400).json({ success: false, message: err.message }) : next()
)), ctrl.importAnalyze);
router.post('/import/apply', ctrl.importApply);

// Excel con plantilla aprendida de una muestra -- ver pilaExcel.service.js.
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (/\.xlsx$/i.test(file.originalname) ? cb(null, true) : cb(new Error('Solo se permiten archivos .xlsx'))),
});
router.get('/download-excel', ctrl.downloadExcel);
router.get('/excel-template', ctrl.getExcelTemplate);
router.put('/excel-template', ctrl.saveExcelTemplate);
router.delete('/excel-template', ctrl.resetExcelTemplate);
router.post('/excel-template/learn', (req, res, next) => uploadXlsx.single('file')(req, res, (err) => (
  err ? res.status(400).json({ success: false, message: err.message }) : next()
)), ctrl.learnExcelTemplate);

module.exports = router;
