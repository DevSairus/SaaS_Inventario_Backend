const express = require('express');
const router = express.Router();
const physicalCountsController = require('../../controllers/inventory/physicalCounts.controller');
const { checkRole } = require('../../middleware/auth');
const uploadExcelMiddleware = require('../../middleware/uploadProductsExcel');

/**
 * Rutas de Inventario físico (conteo por Excel)
 * Base: /api/inventory/physical-counts
 *
 * Mismo criterio de rol que adjustments.routes.js (H4): las acciones que
 * escriben (crear sesión, subir y aplicar/pre-visualizar el conteo) requieren
 * uno de estos roles; las de solo lectura quedan abiertas a cualquier usuario
 * autenticado del tenant, igual que en /api/inventory/adjustments.
 */
const PHYSICAL_COUNT_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];

// Historial y detalle
router.get('/', physicalCountsController.getPhysicalCounts);
router.get('/:id', physicalCountsController.getPhysicalCountById);

// Descargas
router.get('/:id/template', physicalCountsController.downloadTemplate);
router.get('/:id/report', physicalCountsController.downloadReport);

// Crear sesión
router.post('/', checkRole(...PHYSICAL_COUNT_WRITE_ROLES), physicalCountsController.createPhysicalCount);

// Subir Excel (preview con dry_run=true, aplicar con dry_run=false)
router.post(
  '/:id/upload',
  checkRole(...PHYSICAL_COUNT_WRITE_ROLES),
  uploadExcelMiddleware.single('archivo'),
  physicalCountsController.uploadPhysicalCount
);

module.exports = router;
