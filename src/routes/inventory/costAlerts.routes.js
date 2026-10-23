// backend/src/routes/inventory/costAlerts.routes.js
//
// Alertas de costo de compra (variación de costo y precio de venta retenido).
// Base: /api/inventory/cost-alerts

const express = require('express');
const router = express.Router();
const costAlertsController = require('../../controllers/inventory/costAlerts.controller');
const { checkRole } = require('../../middleware/auth');

// Mismos roles que pueden editar productos: resolver puede cambiar el precio de venta.
const COST_ALERTS_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];

router.get('/stats', costAlertsController.getCostAlertsStats);
router.get('/', costAlertsController.getCostAlerts);
router.patch('/:id/resolve', checkRole(...COST_ALERTS_WRITE_ROLES), costAlertsController.resolveCostAlert);
router.patch('/:id/ignore', checkRole(...COST_ALERTS_WRITE_ROLES), costAlertsController.ignoreCostAlert);

module.exports = router;
