// backend/src/routes/crm/automationRules.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/automationRules.controller');
const { checkRole } = require('../../middleware/auth');

// Administrar automatizaciones es una decisión de negocio (a quién se le
// asignan leads, cuándo se crea una tarea automática) — mismo nivel de
// acceso que etapas/plantillas (Fase B.4/B.3).
router.get('/', checkRole('admin', 'manager', 'super_admin'), ctrl.list);
router.post('/', checkRole('admin', 'manager', 'super_admin'), ctrl.create);
router.patch('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.update);
router.delete('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.remove);

module.exports = router;
