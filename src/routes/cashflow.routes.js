// backend/src/routes/cashflow.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const cashflowController = require('../controllers/finance/cashflow.controller');

router.get('/', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlow);
router.get('/pdf', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlowPDF);
router.get('/excel', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlowExcel);

module.exports = router;