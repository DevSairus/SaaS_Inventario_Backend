// backend/src/routes/dian.routes.js
const express = require('express');
const router = express.Router();
const { authMiddleware, checkRole } = require('../middleware/auth');
const { requireModule } = require('../middleware/checkModule');
const ctrl = require('../controllers/dian/dian.controller');

// Todas las rutas requieren autenticación
router.use(authMiddleware);

// Configuración DIAN (certificado, resoluciones, habilitación, auditoría) y
// Documento Soporte: solo roles de gestión. Vendedores/técnicos solo pueden
// emitir facturas/notas desde la venta (rutas de "Operaciones" sin checkRole).
const mgmt = checkRole('admin', 'manager', 'accountant');
// Documento Soporte de gasto + listado → módulo Tesorería (mismo criterio que
// /api/expenses en server.js); de compra → Inventario (/api/inventory/purchases).
const treasury = requireModule('treasury');
const inventory = requireModule('inventory');

// Configuración
router.get('/config',                mgmt, ctrl.getConfig);
router.put('/config',                mgmt, ctrl.updateConfig);

// Catálogo DIVIPOLA (departamentos + municipios), para selectores
router.get('/divipola',              ctrl.getDivipola);

// Resoluciones
router.get('/resolutions',                  mgmt, ctrl.getResolutions);
router.post('/resolutions',                 mgmt, ctrl.createResolution);
router.put('/resolutions/:id',              mgmt, ctrl.updateResolution);
router.delete('/resolutions/:id',           mgmt, ctrl.deactivateResolution);
router.post('/resolutions/:id/reactivate',  mgmt, ctrl.reactivateResolution);
router.delete('/resolutions/:id/permanent', mgmt, ctrl.deleteResolution);

// Operaciones sobre facturas
router.post('/send/:saleId',             ctrl.sendInvoice);
router.post('/send-credit-note/:saleId', ctrl.sendCreditNote);
router.post('/send-debit-note/:saleId',  ctrl.sendDebitNote);
router.post('/create-credit-note/:saleId', ctrl.createAndSendCreditNote);
router.post('/create-debit-note/:saleId',  ctrl.createAndSendDebitNote);
router.post('/check-status/:saleId',     ctrl.checkStatus);
router.post('/test-set/:saleId',         mgmt, ctrl.sendToTestSet);

// Documento Soporte (adquisiciones a no obligados a facturar) — Purchase o Expense
router.get('/support-documents',                                  mgmt, treasury, ctrl.listSupportDocuments);
router.post('/send-support-document/purchase/:purchaseId',        mgmt, inventory, ctrl.sendSupportDocumentPurchase);
router.post('/send-support-document/expense/:expenseId',          mgmt, treasury, ctrl.sendSupportDocumentExpense);
router.get('/support-document/purchase/:purchaseId',              inventory, ctrl.getSupportDocumentStatusPurchase);
router.get('/support-document/expense/:expenseId',                mgmt, treasury, ctrl.getSupportDocumentStatusExpense);
router.post('/check-status-support-document/purchase/:purchaseId', mgmt, inventory, ctrl.checkSupportDocumentStatusPurchase);
router.post('/check-status-support-document/expense/:expenseId',   mgmt, treasury, ctrl.checkSupportDocumentStatusExpense);

// Nota de Ajuste al Documento Soporte (tipo DIAN 95) — Fase 4
router.post('/support-document/:supportDocumentId/adjustment',   mgmt, ctrl.createSupportDocumentAdjustment);
router.get('/support-document/:supportDocumentId/adjustments',   ctrl.listSupportDocumentAdjustments);
router.post('/support-document-adjustment/:adjustmentId/resend', mgmt, ctrl.resendSupportDocumentAdjustment);

// Habilitación y diagnóstico
router.get('/habilitacion-status',   mgmt, ctrl.getHabilitacionStatus);
router.post('/test-connection',      mgmt, ctrl.testConnection);
router.get('/numbering-range',       mgmt, ctrl.getNumberingRange);
router.get('/diagnose-cert',         mgmt, ctrl.diagnoseCert);
router.post('/test-connection-prod', mgmt, ctrl.testConnectionProd);

// Pruebas automáticas — puede tardar hasta 2 min por polling
router.post('/send-auto-test', mgmt, (req, res, next) => {
  req.setTimeout(180000); // 3 min
  res.setTimeout(180000);
  next();
}, ctrl.sendAutoTestDocuments);

// Auditoría
router.get('/events',                mgmt, ctrl.getEvents);

module.exports = router;