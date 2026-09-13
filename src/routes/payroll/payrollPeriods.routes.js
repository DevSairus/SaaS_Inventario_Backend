const express = require('express');
const router = express.Router();
const periodsController = require('../../controllers/payroll/payrollPeriods.controller');
const novedadesController = require('../../controllers/payroll/payrollNovedades.controller');

router.get('/', periodsController.getPayrollPeriods);
router.get('/suggest-next', periodsController.suggestNextPeriod);
router.get('/:id', periodsController.getPayrollPeriodById);
router.post('/', periodsController.createPayrollPeriod);
router.put('/:id', periodsController.updatePayrollPeriod);
router.patch('/:id/status', periodsController.changePayrollPeriodStatus);
router.post('/:id/recalculate-preview', periodsController.recalculatePeriodPreview);
router.post('/:id/copy-novedades', novedadesController.copyNovedadesFromPreviousPeriod);
router.delete('/:id', periodsController.deletePayrollPeriod);

module.exports = router;
