const router = require('express').Router();
const controller = require('../../controllers/inventory/internalConsumptions.controller');
const { authMiddleware } = require('../../middleware/auth');

router.get('/', authMiddleware, controller.getInternalConsumptions);
router.get('/:id', authMiddleware, controller.getInternalConsumptionById);
router.post('/', authMiddleware, controller.createInternalConsumption);
router.put('/:id/approve', authMiddleware, controller.approveInternalConsumption);
router.put('/:id/reject', authMiddleware, controller.rejectInternalConsumption);
router.delete('/:id', authMiddleware, controller.deleteInternalConsumption);

module.exports = router;