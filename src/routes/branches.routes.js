// backend/src/routes/branches.routes.js
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const { checkLimits } = require('../middleware/checkLimits');
const controller = require('../controllers/branches/branches.controller');

// Solo admin/manager pueden administrar sedes; cualquier usuario autenticado puede listarlas
// (para el selector de sede en el frontend)
router.get('/', controller.list);
router.get('/:id', controller.getById);
router.post('/', checkRole('admin', 'super_admin'), checkLimits('branches'), controller.create);
router.put('/:id', checkRole('admin', 'super_admin'), controller.update);
router.delete('/:id', checkRole('admin', 'super_admin'), controller.deactivate);

router.get('/:id/users', checkRole('admin', 'super_admin', 'manager'), controller.listUsers);
router.post('/:id/users', checkRole('admin', 'super_admin'), controller.assignUser);
router.delete('/:id/users/:userId', checkRole('admin', 'super_admin'), controller.removeUser);

module.exports = router;
