const express = require('express');
const router = express.Router();
const purchasesController = require('../../controllers/inventory/purchases.controller');
const { requirePermission } = require('../../middleware/requirePermission');
const write = requirePermission('purchases.write');

// Rutas de compras (autenticación aplicada en index.js principal)
router.get('/', purchasesController.getPurchases);
router.get('/stats', purchasesController.getPurchaseStats);
router.get('/retentions/catalog', purchasesController.getRetentionCatalog);
router.post('/retentions/preview', purchasesController.previewRetentions);
router.post('/resolve-products', purchasesController.resolveProductCodes);
router.get('/:id', purchasesController.getPurchaseById);
router.get('/:id/pdf', purchasesController.getPurchaseOrderPdf);
router.post('/:id/send-email', write, purchasesController.sendPurchaseOrderEmail);
router.post('/', write, purchasesController.createPurchase);
router.put('/:id', write, purchasesController.updatePurchase);
router.patch('/:id/confirm', write, purchasesController.confirmPurchase);
router.patch('/:id/receive', write, purchasesController.receivePurchase);
router.patch('/:id/cancel', write, purchasesController.cancelPurchase);
router.patch('/:id/invoice', write, purchasesController.registerSupplierInvoice);
router.delete('/:id', write, purchasesController.deletePurchase);

module.exports = router;