// backend/src/routes/expenses.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const expensesController = require('../controllers/finance/expenses.controller');

router.get('/', checkRole('admin', 'manager', 'accountant'), expensesController.getExpenses);
router.get('/summary', checkRole('admin', 'manager', 'accountant'), expensesController.getExpensesSummary);
router.get('/:id', checkRole('admin', 'manager', 'accountant'), expensesController.getExpenseById);
router.post('/', checkRole('admin', 'manager', 'accountant'), expensesController.createExpense);
router.put('/:id', checkRole('admin', 'manager', 'accountant'), expensesController.updateExpense);
router.delete('/:id', checkRole('admin', 'manager'), expensesController.deleteExpense);
router.post('/:id/payments', checkRole('admin', 'manager', 'accountant'), expensesController.registerPayment);

module.exports = router;
