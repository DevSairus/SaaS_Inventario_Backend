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

// Recálculo del kardex en orden de fecha (costo promedio ponderado): vista
// previa con dry_run=true; al aplicar corrige costos y genera el ajuste contable.
const { checkRole } = require('../../middleware/auth');
const { recalculateKardex } = require('../../services/inventory/kardexRecalc.service');
router.post('/kardex/recalculate', checkRole('admin', 'super_admin', 'accountant', 'manager'), async (req, res) => {
  try {
    const { product_id: productId, from, dry_run: dryRun } = req.body || {};
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ success: false, message: 'Fecha inválida' });
    if (!productId && !from) return res.status(400).json({ success: false, message: 'Indica un producto o una fecha desde la cual revisar' });
    const data = await recalculateKardex({
      tenantId: req.user.tenant_id, productId: productId || null, from: from || null,
      apply: dryRun === false || dryRun === 'false', userId: req.user.id,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en recálculo de kardex:', error);
    res.status(500).json({ success: false, message: `No se pudo recalcular: ${error.message}` });
  }
});

// Nota: no hay rutas para crear, editar o borrar movimientos porque
// se crean automáticamente desde otros procesos
// (recepción de compras, ajustes, ventas, etc.)

module.exports = router;