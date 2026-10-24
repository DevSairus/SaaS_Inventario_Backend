// backend/src/routes/sales.routes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/sales/sales.controller');
const voidSale        = require('../controllers/sales/voidSale');
const { applyAdvanceToSale } = require('../controllers/finance/customerAdvances.controller');
const { checkAccountOwnership } = require('../middleware/checkAccountOwnership');
const { checkRole } = require('../middleware/auth');

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
router.post('/:id/payments',      salesController.registerPayment);
// Retenciones que practicó el cliente (abono sin caja)
router.post('/:id/retentions',    salesController.registerRetentions);
router.post('/:id/apply-advance', applyAdvanceToSale);
// Anulación/devolución: crea Y aprueba la devolución (inventario, cartera,
// caja, nota crédito) -- mismo permiso que aprobar una devolución.
router.post('/:id/void',          checkRole('admin', 'manager', 'accountant'), voidSale);

// Facturación de remisiones confirmadas (si el tenant lo habilitó)
router.post('/consolidate-invoice',   salesController.consolidateInvoice);
router.post('/:id/convert-to-invoice', salesController.convertToInvoice);
router.post('/:id/revert-invoicing',   salesController.revertInvoicing);
router.post('/:id/annul-consolidated', salesController.annulConsolidated);

// Documentos
router.get( '/:id/pdf',            salesController.generatePDF);
router.post('/:id/send-whatsapp',  salesController.sendWhatsApp);
router.post('/:id/share-link',     salesController.generateShareLink);
// Aprobación/rechazo de una cotización registrada por el asesor (el cliente
// respondió por teléfono, en persona...) -- la del cliente va por /public.
router.post('/:id/quote-status',   salesController.setQuoteStatus);
router.get( '/:id/payment-receipt', salesController.generatePaymentReceipt);

module.exports = router;