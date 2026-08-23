// backend/src/routes/sales.routes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/sales/sales.controller');
const voidSale        = require('../controllers/sales/voidSale');
const { applyAdvanceToSale } = require('../controllers/finance/customerAdvances.controller');
const { checkAccountOwnership } = require('../middleware/checkAccountOwnership');

// Estadísticas (debe ir antes de /:id)
router.get('/stats', salesController.getStats);

// CRUD de ventas
router.get('/',    salesController.getAll);
router.get('/:id', salesController.getById);
// checkAccountOwnership: no bloquea nada salvo que el customer_id sea una
// cuenta marcada explícitamente como asignada a otro asesor (§5-bis CRM).
router.post('/',   checkAccountOwnership, salesController.create);
router.put('/:id', salesController.update);
router.delete('/:id', salesController.delete);

// Acciones especiales
router.post('/:id/confirm',       salesController.confirm);
router.post('/:id/cancel',        salesController.cancel);
router.post('/:id/deliver',       salesController.markAsDelivered);
router.post('/:id/payments',      salesController.registerPayment);
router.post('/:id/apply-advance', applyAdvanceToSale);
router.post('/:id/void',          voidSale);              // ← anulación/devolución

// Documentos
router.get( '/:id/pdf',            salesController.generatePDF);
router.post('/:id/send-whatsapp',  salesController.sendWhatsApp);
router.post('/:id/share-link',     salesController.generateShareLink);
router.get( '/:id/payment-receipt', salesController.generatePaymentReceipt);

module.exports = router;