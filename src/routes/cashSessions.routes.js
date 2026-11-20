// backend/src/routes/cashSessions.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/finance/cashSessions.controller');

router.get('/current',        checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getCurrentSession);
router.post('/open',          checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.openSession);
router.get('/:id/summary',    checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getSessionSummary);
router.get('/:id/payments',   checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getSessionPayments);
router.post('/:id/close',     checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.closeSession);
// Corregir un faltante después del cierre (dinero encontrado / empleado repone).
router.post('/:id/adjustments', checkRole('admin', 'manager', 'accountant'), ctrl.addAdjustment);
router.get('/:id',            checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getSessionById);
router.get('/',                checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.listSessions);

module.exports = router;