const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/inventory/reports.controller');

// Movimientos por mes (entradas vs salidas)
router.get('/movements', reportsController.getMovementsByMonth);

// Valorización de inventario por categoría
router.get('/valuation', reportsController.getValuation);

// Ganancia por producto
router.get('/profit', reportsController.getProfitReport);

// Rotación de inventario
router.get('/rotation', reportsController.getRotationReport);

module.exports = router;