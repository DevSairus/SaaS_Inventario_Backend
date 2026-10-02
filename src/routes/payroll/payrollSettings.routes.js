const express = require('express');
const router = express.Router();
const settingsController = require('../../controllers/payroll/payrollSettings.controller');
const accountingController = require('../../controllers/payroll/payrollAccounting.controller');

// Autenticación/tenant/módulo aplicados en server.js. GET es de lectura
// libre (el formulario de novedades lo necesita); PUT se restringe a
// admin/super_admin dentro del controller.
router.get('/', settingsController.getPayrollSettings);
router.put('/', settingsController.updatePayrollSettings);
// Cierre anual de cesantías e intereses (causación o ajuste según el modo) -- admin.
router.post('/cesantias-year-end', accountingController.closeCesantiasYear);
// Consignación anual de cesantías a los fondos
router.get('/cesantias-annual', accountingController.getCesantiasAnnual);
router.post('/cesantias-annual/consign', accountingController.consignCesantias);
router.post('/cesantias-annual/payments/:paymentId/void', accountingController.voidCesantiasPayment);

module.exports = router;
