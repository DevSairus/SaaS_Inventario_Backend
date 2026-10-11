// backend/src/routes/customer-advances.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/finance/customerAdvances.controller');
const { checkRole } = require('../middleware/auth');

router.get('/',           ctrl.listAdvances);
router.get('/:id',        ctrl.getAdvanceById);
router.post('/',          ctrl.createAdvance);
// Devolver o anular un anticipo mueve caja y reversa asientos: solo gestión.
router.post('/:id/refund', checkRole('admin', 'manager', 'accountant'), ctrl.refundAdvance);
router.post('/:id/void',   checkRole('admin', 'manager', 'accountant'), ctrl.voidAdvance);
// Reasignar a otro cliente: solo personal de contabilidad.
// Mismos roles de gestión que Devolver/Anular.
router.post('/:id/reassign', checkRole('admin', 'manager', 'accountant'), ctrl.reassignAdvance);

module.exports = router;
