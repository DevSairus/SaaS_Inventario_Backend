const router = require('express').Router();
const controller = require('../../controllers/inventory/supplierReturns.controller');
const { authMiddleware, checkRole } = require('../../middleware/auth');

// Aprobar mueve inventario y genera asiento; rechazar/eliminar cierran el
// trámite: solo roles de gestión. Crear y consultar sigue abierto.
const mgmt = checkRole('admin', 'manager', 'accountant');

router.get('/', authMiddleware, controller.getSupplierReturns);
// Antes de '/:id': vista previa de la liquidación (modal de aprobar).
router.get('/preview', authMiddleware, controller.getSupplierReturnSettlementPreview);
router.get('/:id', authMiddleware, controller.getSupplierReturnById);
router.post('/', authMiddleware, controller.createSupplierReturn);
router.put('/:id/approve', authMiddleware, mgmt, controller.approveSupplierReturn);
router.post('/:id/apply-credit', authMiddleware, mgmt, controller.applySupplierReturnCredit);
router.post('/:id/support-adjustment', authMiddleware, mgmt, controller.issueSupplierReturnSupportAdjustment);
router.post('/:id/reverse', authMiddleware, mgmt, controller.reverseSupplierReturn);
router.put('/:id/reject', authMiddleware, mgmt, controller.rejectSupplierReturn);
router.delete('/:id', authMiddleware, mgmt, controller.deleteSupplierReturn);

module.exports = router;