// backend/src/routes/crm/rewards.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/rewards.controller');
const { checkRole } = require('../../middleware/auth');

// Consultar: abierto a cualquier rol del CRM — el propio endpoint ya scopea
// con applyOwnershipScope (vendedor lo suyo, manager su sede, admin todo),
// igual que el resto de datos del CRM (§10.3).
router.get('/', ctrl.list);
router.get('/badges', ctrl.listBadges);

// Actuar sobre la plata: solo quien administra.
router.get('/unmatched-users', checkRole('admin', 'manager', 'super_admin'), ctrl.unmatchedUsers);
router.post('/:id/approve', checkRole('admin', 'super_admin'), ctrl.approve);
router.post('/:id/charge-to-payroll', checkRole('admin', 'super_admin'), ctrl.chargeToPayroll);
router.post('/:id/relink-employee', checkRole('admin', 'super_admin'), ctrl.relinkEmployee);

module.exports = router;