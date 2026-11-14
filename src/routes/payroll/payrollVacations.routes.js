const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/payroll/payrollVacations.controller');

// Autenticación/tenant/módulo aplicados en server.js
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.get);
router.get('/:id/pdf', ctrl.pdf);
router.post('/:id/pay', ctrl.pay);
router.post('/:id/attach', ctrl.attach);
router.post('/:id/void', ctrl.void);

module.exports = router;
