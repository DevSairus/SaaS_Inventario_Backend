// backend/src/routes/sales.routes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/sales/sales.controller');
const voidSale        = require('../controllers/sales/voidSale');

// Estadísticas (debe ir antes de /:id)
router.get('/stats', salesController.getStats);

// CRUD de ventas
router.get('/',    salesController.getAll);
router.get('/:id', salesController.getById);
router.post('/',   salesController.create);
router.put('/:id', salesController.update);
router.delete('/:id', salesController.delete);

// Acciones especiales
router.post('/:id/confirm',       salesController.confirm);
router.post('/:id/cancel',        salesController.cancel);
router.post('/:id/deliver',       salesController.markAsDelivered);
router.post('/:id/payments',      salesController.registerPayment);
router.post('/:id/void',          voidSale);              // ← anulación/devolución

// Documentos
router.get( '/:id/pdf',            salesController.generatePDF);
router.post('/:id/send-whatsapp',  salesController.sendWhatsApp);
router.get( '/:id/payment-receipt', salesController.generatePaymentReceipt);

module.exports = router;