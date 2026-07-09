// backend/src/routes/cashSessions.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const ctrl = require('../controllers/finance/cashSessions.controller');

router.get('/current',        checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getCurrentSession);
router.post('/open',          checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.openSession);
router.get('/:id/summary',    checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getSessionSummary);
router.post('/:id/close',     checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.closeSession);
router.get('/:id',            checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.getSessionById);
router.get('/',                checkRole('admin', 'manager', 'accountant', 'seller'), ctrl.listSessions);

module.exports = router;