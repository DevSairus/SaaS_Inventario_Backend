const express = require('express');
const router = express.Router();
const periodsController = require('../../controllers/payroll/payrollPeriods.controller');
const novedadesController = require('../../controllers/payroll/payrollNovedades.controller');
const accountingController = require('../../controllers/payroll/payrollAccounting.controller');

router.get('/', periodsController.getPayrollPeriods);
router.get('/suggest-next', periodsController.suggestNextPeriod);
router.get('/:id', periodsController.getPayrollPeriodById);
router.post('/', periodsController.createPayrollPeriod);
router.put('/:id', periodsController.updatePayrollPeriod);
router.patch('/:id/status', periodsController.changePayrollPeriodStatus);
router.post('/:id/recalculate-preview', periodsController.recalculatePeriodPreview);
router.post('/:id/copy-novedades', novedadesController.copyNovedadesFromPreviousPeriod);
// Comprobantes contables (nómina, aportes/provisiones) y desembolsos
router.get('/:id/accounting', accountingController.getPeriodAccounting);
router.post('/:id/accounting/generate', accountingController.generatePeriodAccounting);
router.post('/:id/accounting/regenerate', accountingController.regeneratePeriodAccounting);
router.post('/:id/payments', accountingController.createPeriodPayment);
router.post('/:id/payments/:paymentId/void', accountingController.voidPeriodPayment);
router.delete('/:id', periodsController.deletePayrollPeriod);

module.exports = router;
