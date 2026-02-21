const router = require('express').Router();
const controller = require('../../controllers/inventory/transfers.controller');
const { authMiddleware } = require('../../middleware/auth');

router.get('/', authMiddleware, controller.getTransfers);
router.get('/:id', authMiddleware, controller.getTransferById);
router.post('/', authMiddleware, controller.createTransfer);
router.put('/:id/send', authMiddleware, controller.sendTransfer);
router.put('/:id/receive', authMiddleware, controller.receiveTransfer);
router.put('/:id/cancel', authMiddleware, controller.cancelTransfer);
router.delete('/:id', authMiddleware, controller.deleteTransfer);

module.exports = router;