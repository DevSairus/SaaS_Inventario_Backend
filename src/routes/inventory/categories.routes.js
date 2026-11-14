const express = require('express');
const router = express.Router();
const {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deactivateCategory,
  deleteCategoryPermanently
} = require('../../controllers/inventory/categories.controller');
const { authMiddleware } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/requirePermission');

// INV-4: crear, editar o borrar categorías: permisos por empresa (antes, lista fija
// admin/manager/warehouse_keeper).

router.use(authMiddleware);

/**
 * @route   GET /api/categories
 * @desc    Obtener todas las categorías
 * @access  Private
 */
router.get('/', getAllCategories);

/**
 * @route   GET /api/categories/:id
 * @desc    Obtener una categoría por ID
 * @access  Private
 */
router.get('/:id', getCategoryById);

/**
 * @route   POST /api/categories
 * @desc    Crear una nueva categoría
 * @access  Private
 */
router.post('/', requirePermission('inventory.categories.create'), createCategory);

/**
 * @route   PUT /api/categories/:id
 * @desc    Actualizar una categoría
 * @access  Private
 */
router.put('/:id', requirePermission('inventory.categories.edit'), updateCategory);

/**
 * @route   PATCH /api/categories/:id/deactivate
 * @desc    Desactivar una categoría
 * @access  Private
 */
router.patch('/:id/deactivate', requirePermission('inventory.categories.edit'), deactivateCategory);

/**
 * @route   DELETE /api/categories/:id
 * @desc    Eliminar categoría permanentemente
 * @access  Private
 */
router.delete('/:id', requirePermission('inventory.categories.delete'), deleteCategoryPermanently);

module.exports = router;