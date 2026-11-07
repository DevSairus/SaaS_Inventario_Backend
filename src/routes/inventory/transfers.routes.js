const router = require('express').Router();
const controller = require('../../controllers/inventory/transfers.controller');
const { authMiddleware } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/requirePermission');

// Permiso por empresa (config/permissions.catalog.js); antes, lista fija de roles.

router.get('/', authMiddleware, controller.getTransfers);
router.get('/:id', authMiddleware, controller.getTransferById);
router.post('/', authMiddleware, requirePermission('inventory.transfers.write'), controller.createTransfer);
router.put('/:id/send', authMiddleware, requirePermission('inventory.transfers.write'), controller.sendTransfer);
router.put('/:id/receive', authMiddleware, requirePermission('inventory.transfers.write'), controller.receiveTransfer);
router.put('/:id/cancel', authMiddleware, requirePermission('inventory.transfers.write'), controller.cancelTransfer);
router.put('/:id/close', authMiddleware, requirePermission('inventory.transfers.close'), controller.closeTransfer);
router.delete('/:id', authMiddleware, requirePermission('inventory.transfers.write'), controller.deleteTransfer);

module.exports = router;
