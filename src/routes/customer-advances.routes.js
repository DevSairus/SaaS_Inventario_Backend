// backend/src/routes/customer-advances.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/finance/customerAdvances.controller');
const { checkRole } = require('../middleware/auth');

router.get('/',           ctrl.listAdvances);
router.get('/:id',        ctrl.getAdvanceById);
router.post('/',          ctrl.createAdvance);
router.post('/:id/refund', ctrl.refundAdvance);
router.post('/:id/void',   ctrl.voidAdvance);
// Reasignar a otro cliente: solo personal de contabilidad.
router.post('/:id/reassign', checkRole('admin', 'super_admin', 'accountant'), ctrl.reassignAdvance);

module.exports = router;
