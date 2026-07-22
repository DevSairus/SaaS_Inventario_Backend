// backend/src/routes/receipts.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/finance/receipts.controller');

router.get('/', checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.listReceipts);
router.get('/:id', checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getReceiptById);
router.get('/:id/pdf', checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getReceiptPdf);

module.exports = router;
