const express = require('express');
const router = express.Router();
const movementsController = require('../../controllers/inventory/movements.controller');

/**
 * Rutas para movimientos de inventario
 * Base: /api/inventory/movements
 */

// Obtener todos los movimientos (con filtros)
router.get('/', movementsController.getMovements);

// Obtener kardex de un producto
router.get('/kardex/:product_id', movementsController.getProductKardex);

// Obtener estadísticas
router.get('/stats', movementsController.getMovementsStats);

// Nota: No hay rutas POST/PUT/DELETE porque los movimientos
// se crean automáticamente desde otros procesos
// (recepción de compras, ajustes, ventas, etc.)

module.exports = router;