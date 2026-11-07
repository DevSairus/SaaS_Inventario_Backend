// backend/src/routes/expenses.routes.js
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/requirePermission');
const expensesController = require('../controllers/finance/expenses.controller');

router.get('/', requirePermission('expenses.write'), expensesController.getExpenses);
router.get('/summary', requirePermission('expenses.write'), expensesController.getExpensesSummary);
router.get('/:id', requirePermission('expenses.write'), expensesController.getExpenseById);
router.post('/', requirePermission('expenses.write'), expensesController.createExpense);
router.put('/:id', requirePermission('expenses.write'), expensesController.updateExpense);
router.delete('/:id', requirePermission('expenses.delete'), expensesController.deleteExpense);
router.post('/:id/payments', requirePermission('expenses.write'), expensesController.registerPayment);

module.exports = router;
