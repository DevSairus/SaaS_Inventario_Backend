const express = require('express');
const router = express.Router();
const stockAlertsController = require('../controllers/stockAlerts.controller');

/**
 * Rutas para alertas de stock
 * Base: /api/stock-alerts
 */

// Obtener estadísticas (debe ir antes de /:id)
router.get('/stats', stockAlertsController.getStockAlertsStats);

// Verificar y crear alertas manualmente
router.post('/check', stockAlertsController.checkAndCreateAlerts);

// Obtener todas las alertas (con filtros)
router.get('/', stockAlertsController.getStockAlerts);

// Obtener una alerta por ID
router.get('/:id', stockAlertsController.getStockAlertById);

// Resolver alerta
router.patch('/:id/resolve', stockAlertsController.resolveStockAlert);

// Ignorar alerta
router.patch('/:id/ignore', stockAlertsController.ignoreStockAlert);

// Reactivar alerta
router.patch('/:id/reactivate', stockAlertsController.reactivateStockAlert);

// Eliminar alerta
router.delete('/:id', stockAlertsController.deleteStockAlert);

module.exports = router;