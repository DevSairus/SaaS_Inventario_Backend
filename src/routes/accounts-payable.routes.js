// backend/src/routes/accounts-payable.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const accountsPayableController = require('../controllers/inventory/accountsPayable.controller');

// Obtener resumen de cuentas por pagar
router.get(
  '/summary',
  checkRole('admin', 'manager', 'accountant'),
  accountsPayableController.getAccountsPayableSummary
);

// Obtener reporte de antigüedad de saldos
router.get(
  '/aging-report',
  checkRole('admin', 'manager', 'accountant'),
  accountsPayableController.getAgingReport
);

// Obtener cuentas por pagar de un proveedor específico
router.get(
  '/supplier/:supplierId',
  checkRole('admin', 'manager', 'accountant'),
  accountsPayableController.getSupplierAccountsPayable
);

// Obtener historial de pagos de una compra
router.get(
  '/payment-history/:purchaseId',
  checkRole('admin', 'manager', 'accountant'),
  accountsPayableController.getPaymentHistory
);

// Registrar un abono a proveedor
router.post(
  '/:id/payments',
  checkRole('admin', 'manager', 'accountant'),
  accountsPayableController.registerPayment
);

module.exports = router;
