// backend/src/routes/accounts-receivable.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const accountsReceivableController = require('../controllers/sales/accounts-receivable.controller');

// Obtener resumen de cartera
router.get(
  '/summary',
  checkRole('admin', 'manager', 'accountant'),
  accountsReceivableController.getAccountsReceivableSummary
);

// Obtener reporte de antigüedad de saldos
router.get(
  '/aging-report',
  checkRole('admin', 'manager', 'accountant'),
  accountsReceivableController.getAgingReport
);

// Obtener cartera de un cliente específico
router.get(
  '/customer/:customerId',
  checkRole('admin', 'manager', 'accountant', 'seller'),
  accountsReceivableController.getCustomerAccountsReceivable
);

// Obtener historial de pagos de una factura
router.get(
  '/payment-history/:saleId',
  checkRole('admin', 'manager', 'accountant', 'seller'),
  accountsReceivableController.getPaymentHistory
);

module.exports = router;