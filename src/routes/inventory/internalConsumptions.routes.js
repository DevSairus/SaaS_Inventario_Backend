const router = require('express').Router();
const controller = require('../../controllers/inventory/internalConsumptions.controller');
const { authMiddleware, checkRole } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/requirePermission');

// INV-4: cualquier usuario puede solicitar un consumo interno, pero aprobarlo
// descuenta stock, así que solo gerencia aprueba o rechaza.
const CONSUMPTION_APPROVE_ROLES = ['admin', 'manager', 'super_admin'];
// Eliminar: permiso por empresa (antes, lista fija admin/manager/warehouse_keeper).

router.get('/', authMiddleware, controller.getInternalConsumptions);
router.get('/:id', authMiddleware, controller.getInternalConsumptionById);
router.post('/', authMiddleware, controller.createInternalConsumption);
router.put('/:id/approve', authMiddleware, requirePermission('inventory.consumptions.approve'), controller.approveInternalConsumption);
router.put('/:id/reject', authMiddleware, requirePermission('inventory.consumptions.approve'), controller.rejectInternalConsumption);
router.delete('/:id', authMiddleware, requirePermission('inventory.consumptions.delete'), controller.deleteInternalConsumption);

module.exports = router;
