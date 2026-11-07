// backend/src/routes/tools.routes.js
//
// Herramientas (Fase 3 del módulo Proyectos). Base: /api/tools
// (requireModule('projects') en server.js).
//   Ver: cualquier usuario del tenant.
//   Registrar, mantenimiento, calibración y baja: 'tools.manage'.
//   Entregar y recibir (actas): 'tools.assign'.

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/tools/tools.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/requirePermission');

const manage = requirePermission('tools.manage');
const assign = requirePermission('tools.assign');

router.get('/', ctrl.list);
router.get('/options/responsibles', requireAnyPermission('tools.assign', 'tools.manage'), ctrl.responsibles);
router.get('/options/fixed-assets', manage, ctrl.fixedAssets);
router.get('/project/:projectId', ctrl.projectTools);
router.post('/assignments/:assignmentId/return', assign, ctrl.returnAssignment);
router.get('/assignments/:assignmentId/acta/:kind', ctrl.actaPdf);
router.post('/', manage, ctrl.create);

router.get('/:id', ctrl.getById);
router.put('/:id', manage, ctrl.update);
router.post('/:id/assign', assign, ctrl.assign);
router.post('/:id/events', manage, ctrl.addEvent);
router.post('/:id/service', manage, ctrl.setService);
router.post('/:id/retire', manage, ctrl.retire);

module.exports = router;
