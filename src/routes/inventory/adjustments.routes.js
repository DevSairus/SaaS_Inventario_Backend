const express = require('express');
const router = express.Router();
const adjustmentsController = require('../../controllers/inventory/adjustments.controller');

/**
 * Rutas para ajustes de inventario
 * Base: /api/inventory/adjustments
 */

// Obtener estadísticas (debe ir antes de /:id)
router.get('/stats', adjustmentsController.getAdjustmentsStats);

// Obtener todos los ajustes (con filtros)
router.get('/', adjustmentsController.getAdjustments);

// Obtener un ajuste por ID
router.get('/:id', adjustmentsController.getAdjustmentById);

// Crear nuevo ajuste
router.post('/', adjustmentsController.createAdjustment);

// Actualizar ajuste (solo draft)
router.put('/:id', adjustmentsController.updateAdjustment);

// Confirmar ajuste (genera movimientos)
router.patch('/:id/confirm', adjustmentsController.confirmAdjustment);

// Cancelar ajuste
router.patch('/:id/cancel', adjustmentsController.cancelAdjustment);

// Eliminar ajuste (solo draft)
router.delete('/:id', adjustmentsController.deleteAdjustment);

module.exports = router;