const express = require('express');
const router = express.Router();
const purchasesController = require('../../controllers/inventory/purchases.controller');

// Rutas de compras (autenticación aplicada en index.js principal)
router.get('/', purchasesController.getPurchases);
router.get('/stats', purchasesController.getPurchaseStats);
router.get('/:id', purchasesController.getPurchaseById);
router.post('/', purchasesController.createPurchase);
router.put('/:id', purchasesController.updatePurchase);
router.patch('/:id/confirm', purchasesController.confirmPurchase);
router.patch('/:id/receive', purchasesController.receivePurchase);
router.patch('/:id/cancel', purchasesController.cancelPurchase);
router.delete('/:id', purchasesController.deletePurchase);

module.exports = router;