// backend/src/routes/posTickets.routes.js
// Tirillas POS. Mismos permisos que los documentos que representan: la venta
// como su PDF (sin restricción de rol), recibos y caja como en Tesorería.
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/posTickets.controller');

const TREASURY_ROLES = ['admin', 'manager', 'accountant', 'seller'];

router.get('/sale/:id', ctrl.getSaleTicket);
router.get('/receipt/:id', checkRole(...TREASURY_ROLES), ctrl.getReceiptTicket);
router.get('/payment/:paymentId', checkRole(...TREASURY_ROLES), ctrl.getReceiptTicket);
router.get('/cash-session/:id', checkRole(...TREASURY_ROLES), ctrl.getCashSessionTicket);

module.exports = router;
