const express = require('express');
const router = express.Router();
const { checkRole } = require('../../middleware/auth');
const ctrl = require('../../controllers/workshop/commissionCategories.controller');

router.get('/diagram-systems',      ctrl.listDiagramSystems);
router.get('/diagram-mappings',     ctrl.listDiagramMappings);
router.put('/diagram-mappings',     checkRole('admin', 'super_admin'), ctrl.setDiagramMappings);

router.get('/',                     ctrl.list);
router.post('/',                    checkRole('admin', 'super_admin'), ctrl.create);
router.put('/:id',                  checkRole('admin', 'super_admin'), ctrl.update);
router.delete('/:id',               checkRole('admin', 'super_admin'), ctrl.remove);
router.put('/:id/technician-rates', checkRole('admin', 'super_admin'), ctrl.setTechnicianRates);

module.exports = router;
