// backend/src/routes/crm/customers360.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/customers360.controller');
const { checkRole } = require('../../middleware/auth');

router.get('/:id/timeline', ctrl.getTimeline);
router.get('/:id/interactions', ctrl.listInteractions);
router.post('/:id/interactions', ctrl.createInteraction);

// Asignar/liberar cuenta — solo roles con visión de equipo (§5-bis).
router.patch('/:id/assign', checkRole('admin', 'manager', 'super_admin'), ctrl.assignAccount);

module.exports = router;
