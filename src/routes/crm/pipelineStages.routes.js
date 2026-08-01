// backend/src/routes/crm/pipelineStages.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/pipelineStages.controller');
const { checkRole } = require('../../middleware/auth');

router.get('/', ctrl.list);
router.post('/', checkRole('admin', 'manager', 'super_admin'), ctrl.create);
router.patch('/reorder', checkRole('admin', 'manager', 'super_admin'), ctrl.reorder);
router.patch('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.update);
router.delete('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.remove);

module.exports = router;
