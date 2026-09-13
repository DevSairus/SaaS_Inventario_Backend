const express = require('express');
const router = express.Router();
const employeesController = require('../../controllers/payroll/employees.controller');

// Autenticación/tenant/módulo aplicados en server.js
router.get('/', employeesController.getEmployees);
router.get('/stats', employeesController.getEmployeeStats);
router.get('/contracts/expiring', employeesController.getExpiringContracts);
router.get('/:id', employeesController.getEmployeeById);
router.post('/', employeesController.createEmployee);
router.put('/:id', employeesController.updateEmployee);
router.patch('/:id/deactivate', employeesController.deactivateEmployee);
router.patch('/:id/activate', employeesController.activateEmployee);
router.delete('/:id', employeesController.deleteEmployee);

module.exports = router;
