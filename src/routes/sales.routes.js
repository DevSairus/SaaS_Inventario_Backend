// backend/src/routes/sales.routes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/sales/sales.controller');

// Rutas de ventas (autenticación y tenant aplicados en server.js)

// Estadísticas (debe ir antes de /:id)
router.get('/stats', salesController.getStats);

// CRUD de ventas
router.get('/', salesController.getAll);
router.get('/:id', salesController.getById);
router.post('/', salesController.create);
router.put('/:id', salesController.update);
router.delete('/:id', salesController.delete);

// Acciones especiales
router.post('/:id/confirm', salesController.confirm);
router.post('/:id/cancel', salesController.cancel);
router.post('/:id/deliver', salesController.markAsDelivered);
router.post('/:id/payments', salesController.registerPayment);

// Generar PDF
router.get('/:id/pdf', salesController.generatePDF);
router.get('/:id/payment-receipt', salesController.generatePaymentReceipt);

module.exports = router;