const router = require('express').Router();
const controller = require('../../controllers/inventory/transfers.controller');
const { authMiddleware, checkRole } = require('../../middleware/auth');

// INV-4: crear/enviar/recibir/cancelar mueve stock entre bodegas; antes
// cualquier usuario autenticado del tenant podía hacerlo por API.
const TRANSFERS_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];

router.get('/', authMiddleware, controller.getTransfers);
router.get('/:id', authMiddleware, controller.getTransferById);
router.post('/', authMiddleware, checkRole(...TRANSFERS_WRITE_ROLES), controller.createTransfer);
router.put('/:id/send', authMiddleware, checkRole(...TRANSFERS_WRITE_ROLES), controller.sendTransfer);
router.put('/:id/receive', authMiddleware, checkRole(...TRANSFERS_WRITE_ROLES), controller.receiveTransfer);
router.put('/:id/cancel', authMiddleware, checkRole(...TRANSFERS_WRITE_ROLES), controller.cancelTransfer);
router.delete('/:id', authMiddleware, checkRole(...TRANSFERS_WRITE_ROLES), controller.deleteTransfer);

module.exports = router;
