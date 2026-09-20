// backend/src/routes/crm/goals.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/goals.controller');
const { checkRole } = require('../../middleware/auth');

// Ver metas y progreso: cualquier rol del CRM (necesitan ver su propio
// camino/barra). Administrar metas: mismo nivel que automatizaciones/etapas.
router.get('/', ctrl.list);
router.get('/progress', ctrl.getProgress);
// Fase 4 (§6) — cumplimiento histórico. Abierto a cualquier rol del CRM
// igual que /progress: el propio endpoint ya restringe QUÉ se ve
// (resolveVisibleTargets), no hace falta un checkRole que le impida a un
// vendedor mirar su propio histórico.
router.get('/compliance', ctrl.getCompliance);
// Fase 6 — alertas propias (período por vencer + cuánto falta). Cualquier
// rol: cada asesor necesita ver sus propias alertas, no solo el admin.
router.get('/alerts', ctrl.getGoalAlerts);
router.post('/', checkRole('admin', 'manager', 'super_admin'), ctrl.create);
router.patch('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.update);
router.delete('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.remove);

module.exports = router;