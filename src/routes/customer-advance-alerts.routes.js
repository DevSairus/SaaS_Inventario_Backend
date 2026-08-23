// backend/src/routes/customer-advance-alerts.routes.js
//
// Alertas de antigüedad de Anticipos de Clientes sin aplicar.
// Base: /api/customer-advance-alerts
// Ver Anticipos-Clientes-Analisis-y-Plan.md §10 (Fase 4, punto 2).

const express = require('express');
const router = express.Router();
const advanceAlertsController = require('../controllers/finance/customerAdvanceAlerts.controller');
const { checkRole } = require('../middleware/auth');

// Estadísticas (antes de /:id)
router.get('/stats', advanceAlertsController.getAdvanceAlertsStats);

// Informe de antigüedad de saldos por rango de días (antes de /:id)
router.get('/aging', advanceAlertsController.getAdvancesAging);

// Verificar y crear alertas manualmente
router.post(
  '/check',
  checkRole('admin', 'manager', 'accountant'),
  advanceAlertsController.checkAndCreateAlerts
);

// Listado con filtros
router.get('/', advanceAlertsController.getAdvanceAlerts);

// Detalle
router.get('/:id', advanceAlertsController.getAdvanceAlertById);

// Resolver
router.patch(
  '/:id/resolve',
  checkRole('admin', 'manager', 'accountant'),
  advanceAlertsController.resolveAdvanceAlert
);

// Ignorar
router.patch(
  '/:id/ignore',
  checkRole('admin', 'manager', 'accountant'),
  advanceAlertsController.ignoreAdvanceAlert
);

// Reactivar
router.patch(
  '/:id/reactivate',
  checkRole('admin', 'manager', 'accountant'),
  advanceAlertsController.reactivateAdvanceAlert
);

module.exports = router;
