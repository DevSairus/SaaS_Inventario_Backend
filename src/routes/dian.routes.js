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

// Catálogo DIVIPOLA (departamentos + municipios), para selectores
router.get('/divipola',              ctrl.getDivipola);

// Resoluciones
router.get('/resolutions',                  ctrl.getResolutions);
router.post('/resolutions',                 ctrl.createResolution);
router.put('/resolutions/:id',              ctrl.updateResolution);
router.delete('/resolutions/:id',           ctrl.deactivateResolution);
router.post('/resolutions/:id/reactivate',  ctrl.reactivateResolution);
router.delete('/resolutions/:id/permanent', ctrl.deleteResolution);

// Operaciones sobre facturas
router.post('/send/:saleId',             ctrl.sendInvoice);
router.post('/send-credit-note/:saleId', ctrl.sendCreditNote);
router.post('/send-debit-note/:saleId',  ctrl.sendDebitNote);
router.post('/create-credit-note/:saleId', ctrl.createAndSendCreditNote);
router.post('/create-debit-note/:saleId',  ctrl.createAndSendDebitNote);
router.post('/check-status/:saleId',     ctrl.checkStatus);
router.post('/test-set/:saleId',         ctrl.sendToTestSet);

// Documento Soporte (adquisiciones a no obligados a facturar) — Purchase o Expense
router.get('/support-documents',                                  ctrl.listSupportDocuments);
router.post('/send-support-document/purchase/:purchaseId',        ctrl.sendSupportDocumentPurchase);
router.post('/send-support-document/expense/:expenseId',          ctrl.sendSupportDocumentExpense);
router.get('/support-document/purchase/:purchaseId',              ctrl.getSupportDocumentStatusPurchase);
router.get('/support-document/expense/:expenseId',                ctrl.getSupportDocumentStatusExpense);
router.post('/check-status-support-document/purchase/:purchaseId', ctrl.checkSupportDocumentStatusPurchase);
router.post('/check-status-support-document/expense/:expenseId',   ctrl.checkSupportDocumentStatusExpense);

// Nota de Ajuste al Documento Soporte (tipo DIAN 95) — Fase 4
router.post('/support-document/:supportDocumentId/adjustment',   ctrl.createSupportDocumentAdjustment);
router.get('/support-document/:supportDocumentId/adjustments',   ctrl.listSupportDocumentAdjustments);

// Habilitación y diagnóstico
router.get('/habilitacion-status',   ctrl.getHabilitacionStatus);
router.post('/test-connection',      ctrl.testConnection);
router.get('/numbering-range',       ctrl.getNumberingRange);
router.get('/diagnose-cert',         ctrl.diagnoseCert);
router.post('/test-connection-prod', ctrl.testConnectionProd);

// Pruebas automáticas — puede tardar hasta 2 min por polling
router.post('/send-auto-test', (req, res, next) => {
  req.setTimeout(180000); // 3 min
  res.setTimeout(180000);
  next();
}, ctrl.sendAutoTestDocuments);

// Auditoría
router.get('/events',                ctrl.getEvents);

module.exports = router;