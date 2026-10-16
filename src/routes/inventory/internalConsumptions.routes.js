const router = require('express').Router();
const controller = require('../../controllers/inventory/internalConsumptions.controller');
const { authMiddleware, checkRole } = require('../../middleware/auth');

// INV-4: cualquier usuario puede solicitar un consumo interno, pero aprobarlo
// descuenta stock, así que solo gerencia aprueba o rechaza.
const CONSUMPTION_APPROVE_ROLES = ['admin', 'manager', 'super_admin'];
const CONSUMPTION_DELETE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];

router.get('/', authMiddleware, controller.getInternalConsumptions);
router.get('/:id', authMiddleware, controller.getInternalConsumptionById);
router.post('/', authMiddleware, controller.createInternalConsumption);
router.put('/:id/approve', authMiddleware, checkRole(...CONSUMPTION_APPROVE_ROLES), controller.approveInternalConsumption);
router.put('/:id/reject', authMiddleware, checkRole(...CONSUMPTION_APPROVE_ROLES), controller.rejectInternalConsumption);
router.delete('/:id', authMiddleware, checkRole(...CONSUMPTION_DELETE_ROLES), controller.deleteInternalConsumption);

module.exports = router;
