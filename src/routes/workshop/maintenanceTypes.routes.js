const express = require('express');
const router = express.Router();
const { checkRole } = require('../../middleware/auth');
const ctrl = require('../../controllers/workshop/maintenanceTypes.controller');

router.get('/',       ctrl.list);
router.post('/',      checkRole('admin', 'manager', 'super_admin'), ctrl.create);
router.put('/:id',    checkRole('admin', 'manager', 'super_admin'), ctrl.update);
router.delete('/:id', checkRole('admin', 'manager', 'super_admin'), ctrl.remove);

module.exports = router;
