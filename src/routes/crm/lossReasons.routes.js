// backend/src/routes/crm/lossReasons.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/crm/lossReasons.controller');
const { checkRole } = require('../../middleware/auth');

router.get('/', ctrl.list);
router.post('/', checkRole('admin', 'manager', 'super_admin'), ctrl.create);
router.patch('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.update);
router.delete('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.remove);

module.exports = router;
