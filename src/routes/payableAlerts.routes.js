const express = require('express');
const router = express.Router();
const payableAlertsController = require('../controllers/payableAlerts.controller');
const { checkRole } = require('../middleware/auth');

/**
 * Rutas para alertas de cuentas por pagar próximas a vencer
 * Base: /api/payable-alerts
 */

// Obtener estadísticas (debe ir antes de /:id)
router.get('/stats', payableAlertsController.getPayableAlertsStats);

// Verificar y crear alertas manualmente
router.post(
  '/check',
  checkRole('admin', 'manager', 'accountant'),
  payableAlertsController.checkAndCreateAlerts
);

// Obtener todas las alertas (con filtros)
router.get('/', payableAlertsController.getPayableAlerts);

// Obtener una alerta por ID
router.get('/:id', payableAlertsController.getPayableAlertById);

// Resolver alerta
router.patch(
  '/:id/resolve',
  checkRole('admin', 'manager', 'accountant'),
  payableAlertsController.resolvePayableAlert
);

// Ignorar alerta
router.patch(
  '/:id/ignore',
  checkRole('admin', 'manager', 'accountant'),
  payableAlertsController.ignorePayableAlert
);

// Reactivar alerta
router.patch(
  '/:id/reactivate',
  checkRole('admin', 'manager', 'accountant'),
  payableAlertsController.reactivatePayableAlert
);

// Eliminar alerta
router.delete(
  '/:id',
  checkRole('admin', 'manager', 'accountant'),
  payableAlertsController.deletePayableAlert
);

module.exports = router;
