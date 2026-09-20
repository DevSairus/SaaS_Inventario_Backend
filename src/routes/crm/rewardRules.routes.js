// backend/src/routes/crm/rewardRules.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/rewardRules.controller');
const { checkRole } = require('../../middleware/auth');

// Configurar cuánta plata se reparte y bajo qué condición es una decisión de
// negocio — mismo nivel de acceso que metas y automatizaciones.
router.get('/', checkRole('admin', 'manager', 'super_admin'), ctrl.list);
router.post('/', checkRole('admin', 'manager', 'super_admin'), ctrl.create);
router.patch('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.update);
router.delete('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.remove);

module.exports = router;