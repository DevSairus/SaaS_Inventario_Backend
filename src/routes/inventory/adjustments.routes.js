const express = require('express');
const router = express.Router();
const adjustmentsController = require('../../controllers/inventory/adjustments.controller');
const { checkRole } = require('../../middleware/auth');

/**
 * Rutas para ajustes de inventario
 * Base: /api/inventory/adjustments
 */

// H4 del análisis de doble descuento: este router se montaba en server.js
// solo con authMiddleware + tenantMiddleware, sin control de rol -- cualquier
// usuario autenticado del tenant (incluso viewer) podía crear y confirmar
// ajustes de inventario por API. Mismos roles con los que ya se protegen
// altas/bajas en otras áreas administrativas del sistema.
const ADJUSTMENTS_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];

// Obtener estadísticas (debe ir antes de /:id)
router.get('/stats', adjustmentsController.getAdjustmentsStats);

// Obtener todos los ajustes (con filtros)
router.get('/', adjustmentsController.getAdjustments);

// Obtener un ajuste por ID
router.get('/:id', adjustmentsController.getAdjustmentById);

// Crear nuevo ajuste
router.post('/', checkRole(...ADJUSTMENTS_WRITE_ROLES), adjustmentsController.createAdjustment);

// Actualizar ajuste (solo draft)
router.put('/:id', adjustmentsController.updateAdjustment);

// Confirmar ajuste (genera movimientos)
router.patch('/:id/confirm', checkRole(...ADJUSTMENTS_WRITE_ROLES), adjustmentsController.confirmAdjustment);

// Cancelar ajuste
router.patch('/:id/cancel', adjustmentsController.cancelAdjustment);

// Eliminar ajuste (solo draft)
router.delete('/:id', adjustmentsController.deleteAdjustment);

module.exports = router;