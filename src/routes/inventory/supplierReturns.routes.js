const router = require('express').Router();
const controller = require('../../controllers/inventory/supplierReturns.controller');
const { authMiddleware } = require('../../middleware/auth');

router.get('/', authMiddleware, controller.getSupplierReturns);
router.get('/:id', authMiddleware, controller.getSupplierReturnById);
router.post('/', authMiddleware, controller.createSupplierReturn);
router.put('/:id/approve', authMiddleware, controller.approveSupplierReturn);
router.put('/:id/reject', authMiddleware, controller.rejectSupplierReturn);
router.delete('/:id', authMiddleware, controller.deleteSupplierReturn);

module.exports = router;