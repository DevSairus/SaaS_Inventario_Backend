const router = require('express').Router();
const controller = require('../../controllers/sales/customerReturns.controller');
const { authMiddleware } = require('../../middleware/auth');

router.get('/', authMiddleware, controller.getCustomerReturns);
router.get('/:id', authMiddleware, controller.getCustomerReturnById);
router.post('/', authMiddleware, controller.createCustomerReturn);
router.put('/:id/approve', authMiddleware, controller.approveCustomerReturn);
router.put('/:id/reject', authMiddleware, controller.rejectCustomerReturn);
router.delete('/:id', authMiddleware, controller.deleteCustomerReturn);

module.exports = router;