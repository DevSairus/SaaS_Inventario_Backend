// backend/src/routes/inventory/priceAdjustments.routes.js
//
// Ajustes de precio de venta (solo cambian el precio, no costo ni stock).
// Base: /api/inventory/price-adjustments
// Consultar: cualquier usuario del tenant. Crear: los mismos roles que
// cambian márgenes de ganancia.

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/inventory/priceAdjustments.controller');
const { checkRole } = require('../../middleware/auth');

const PRICE_ADJUSTMENT_WRITE_ROLES = ['admin', 'manager', 'super_admin'];
const write = checkRole(...PRICE_ADJUSTMENT_WRITE_ROLES);

router.get('/', ctrl.list);
router.get('/product/:productId', ctrl.productHistory);
router.post('/products-info', write, ctrl.productsInfo);
router.post('/', write, ctrl.create);
router.get('/:id', ctrl.getById);

module.exports = router;
