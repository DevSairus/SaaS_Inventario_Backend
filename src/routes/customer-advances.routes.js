// backend/src/routes/customer-advances.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/finance/customerAdvances.controller');

router.get('/',           ctrl.listAdvances);
router.get('/:id',        ctrl.getAdvanceById);
router.post('/',          ctrl.createAdvance);
router.post('/:id/refund', ctrl.refundAdvance);
router.post('/:id/void',   ctrl.voidAdvance);

module.exports = router;
