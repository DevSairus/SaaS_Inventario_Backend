const express = require('express');
const router = express.Router();
const payrollTerminationController = require('../../controllers/payroll/payrollTermination.controller');

// Autenticación/tenant/módulo aplicados en server.js
router.get('/pending', payrollTerminationController.getPendingTerminations);
router.get('/:employee_id/preview', payrollTerminationController.previewTermination);
router.post('/:employee_id/emit', payrollTerminationController.emitTermination);

module.exports = router;
