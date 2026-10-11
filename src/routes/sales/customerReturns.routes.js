const router = require('express').Router();
const controller = require('../../controllers/sales/customerReturns.controller');
const { authMiddleware, checkRole } = require('../../middleware/auth');

// Aprobar mueve inventario y genera asiento; rechazar/eliminar cierran el
// trámite: solo roles de gestión. Crear y consultar sigue abierto.
const mgmt = checkRole('admin', 'manager', 'accountant');

router.get('/', authMiddleware, controller.getCustomerReturns);
// Antes de '/:id': vista previa de la liquidación (modal de aprobar / anular venta).
router.get('/preview', authMiddleware, controller.getCustomerReturnSettlementPreview);
router.get('/:id', authMiddleware, controller.getCustomerReturnById);
router.post('/', authMiddleware, controller.createCustomerReturn);
router.put('/:id/approve', authMiddleware, mgmt, controller.approveCustomerReturn);
router.post('/:id/credit-note', authMiddleware, mgmt, controller.issueCustomerReturnCreditNote);
router.post('/:id/reverse', authMiddleware, mgmt, controller.reverseCustomerReturn);
router.put('/:id/reject', authMiddleware, mgmt, controller.rejectCustomerReturn);
router.delete('/:id', authMiddleware, mgmt, controller.deleteCustomerReturn);

module.exports = router;