// backend/src/routes/paymentBatches.routes.js
// Lotes de pago a proveedores. Base: /api/payment-batches (requireModule('treasury') en server.js)
//   Armar, editar, enviar, anular, marcar pagado: 'payments.schedule'.
//   Aprobar, rechazar y generar el archivo del banco: 'payments.approve'.
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/finance/paymentBatches.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/requirePermission');

const schedule = requirePermission('payments.schedule');
const approve = requirePermission('payments.approve');
const view = requireAnyPermission('payments.schedule', 'payments.approve');

router.get('/payables', schedule, ctrl.payables);
router.get('/formats', view, ctrl.formats);
router.post('/templates', schedule, ctrl.saveTemplate);
router.put('/templates/:templateId', schedule, ctrl.saveTemplate);
router.delete('/templates/:templateId', schedule, ctrl.deleteTemplate);

router.get('/', view, ctrl.list);
router.post('/', schedule, ctrl.create);
router.get('/:id', view, ctrl.getById);
router.put('/:id', schedule, ctrl.update);
router.post('/:id/submit', schedule, ctrl.submit);
router.post('/:id/approve', approve, ctrl.approve);
router.post('/:id/reject', approve, ctrl.reject);
router.get('/:id/file', approve, ctrl.exportFile);
router.post('/:id/paid', schedule, ctrl.markPaid);
router.post('/:id/cancel', schedule, ctrl.cancel);

module.exports = router;
