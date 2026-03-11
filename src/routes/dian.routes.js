// backend/src/routes/dian.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const ctrl = require('../controllers/dian/dian.controller');

// Todas las rutas requieren autenticación
router.use(authMiddleware);

// Configuración
router.get('/config',                ctrl.getConfig);
router.put('/config',                ctrl.updateConfig);

// Resoluciones
router.get('/resolutions',           ctrl.getResolutions);
router.post('/resolutions',          ctrl.createResolution);
router.delete('/resolutions/:id',    ctrl.deactivateResolution);

// Operaciones sobre facturas
router.post('/send/:saleId',             ctrl.sendInvoice);
router.post('/send-credit-note/:saleId', ctrl.sendCreditNote);
router.post('/send-debit-note/:saleId',  ctrl.sendDebitNote);
router.post('/check-status/:saleId',     ctrl.checkStatus);
router.post('/test-set/:saleId',         ctrl.sendToTestSet);

// Habilitación y diagnóstico
router.get('/habilitacion-status',   ctrl.getHabilitacionStatus);
router.post('/test-connection',      ctrl.testConnection);
router.get('/numbering-range',       ctrl.getNumberingRange);

// Pruebas automáticas — puede tardar hasta 2 min por polling
router.post('/send-auto-test', (req, res, next) => {
  req.setTimeout(180000); // 3 min
  res.setTimeout(180000);
  next();
}, ctrl.sendAutoTestDocuments);

// Auditoría
router.get('/events',                ctrl.getEvents);

module.exports = router;