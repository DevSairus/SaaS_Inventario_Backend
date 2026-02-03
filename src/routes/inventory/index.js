const express = require('express');
const router = express.Router();

const warehousesRoutes = require('./warehouses.routes');
const productsRoutes = require('./products.routes');
const categoriesRoutes = require('./categories.routes');
const suppliersRoutes = require('./suppliers.routes');
const purchasesRoutes = require('./purchases.routes');
const adjustmentsRoutes = require('./adjustments.routes');
const movementsRoutes = require('./movements.routes');

// Nuevas rutas - Movimientos avanzados
const supplierReturnsRoutes = require('./supplierReturns.routes');
const transfersRoutes = require('./transfers.routes');
const internalConsumptionsRoutes = require('./internalConsumptions.routes');

router.use('/warehouses', warehousesRoutes);
router.use('/products', productsRoutes);
router.use('/categories', categoriesRoutes);
router.use('/suppliers', suppliersRoutes);
router.use('/purchases', purchasesRoutes);
router.use('/adjustments', adjustmentsRoutes);
router.use('/movements', movementsRoutes);

// Rutas nuevas
router.use('/supplier-returns', supplierReturnsRoutes);
router.use('/transfers', transfersRoutes);
router.use('/internal-consumptions', internalConsumptionsRoutes);

module.exports = router;