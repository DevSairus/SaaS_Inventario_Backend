const express = require('express');
const router = express.Router();
const settingsController = require('../../controllers/payroll/payrollSettings.controller');

// Autenticación/tenant/módulo aplicados en server.js. GET es de lectura
// libre (el formulario de novedades lo necesita); PUT se restringe a
// admin/super_admin dentro del controller.
router.get('/', settingsController.getPayrollSettings);
router.put('/', settingsController.updatePayrollSettings);

module.exports = router;
