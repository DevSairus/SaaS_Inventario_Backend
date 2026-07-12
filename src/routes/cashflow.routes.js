// backend/src/routes/cashflow.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const cashflowController = require('../controllers/finance/cashflow.controller');

router.get('/', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlow);
router.get('/pdf', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlowPDF);
router.get('/excel', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlowExcel);
// Conciliación con Contabilidad (hallazgo 3.5): compara Tesorería vs. asientos
// posteados en Caja/Bancos y expone si coinciden.
router.get('/reconciliation', checkRole('admin', 'manager', 'accountant'), cashflowController.getCashFlowReconciliation);

module.exports = router;