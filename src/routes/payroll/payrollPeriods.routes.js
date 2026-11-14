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
router.get('/:id/workflow', periodsController.getPayrollPeriodWorkflow);
router.post('/:id/recalculate-preview', periodsController.recalculatePeriodPreview);
router.post('/:id/copy-novedades', novedadesController.copyNovedadesFromPreviousPeriod);
// Horas extra y recargos desde la planilla de las obras (Fase 4, req. 1.1)
const projectHours = require('../../services/payroll/projectHoursPayroll.service');
const hoursHandler = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error('Error en horas de proyectos:', error);
    return res.status(500).json({ success: false, message: 'Error procesando las horas de los proyectos' });
  }
};
router.get('/:id/project-hours', hoursHandler((req) => projectHours.previewPeriodHours(req.user.tenant_id, req.params.id)));
router.post('/:id/project-hours', hoursHandler((req) => projectHours.generatePeriodHours(req.user.tenant_id, req.user.id, req.params.id)));
// Comprobantes contables (nómina, aportes/provisiones) y desembolsos
router.get('/:id/accounting', accountingController.getPeriodAccounting);
router.post('/:id/accounting/generate', accountingController.generatePeriodAccounting);
router.post('/:id/accounting/regenerate', accountingController.regeneratePeriodAccounting);
router.post('/:id/payments', accountingController.createPeriodPayment);
router.post('/:id/payments/:paymentId/void', accountingController.voidPeriodPayment);
router.delete('/:id', periodsController.deletePayrollPeriod);

module.exports = router;
