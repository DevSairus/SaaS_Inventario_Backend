const express = require('express');
const router = express.Router();

// Importar rutas de sales cuando existan
// const salesRoutes = require('./sales.routes');
// const customersRoutes = require('./customers.routes');
const customerReturnsRoutes = require('./customerReturns.routes');

// router.use('/sales', salesRoutes);
// router.use('/customers', customersRoutes);
router.use('/customer-returns', customerReturnsRoutes);

module.exports = router;