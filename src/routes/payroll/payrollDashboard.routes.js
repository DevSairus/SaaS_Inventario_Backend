const express = require('express');
const router = express.Router();
const payrollDashboardController = require('../../controllers/payroll/payrollDashboard.controller');

// Autenticación/tenant/módulo aplicados en server.js
router.get('/', payrollDashboardController.getCostsDashboard);

module.exports = router;
