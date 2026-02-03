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
router.post('/', createCategory);

/**
 * @route   PUT /api/categories/:id
 * @desc    Actualizar una categoría
 * @access  Private
 */
router.put('/:id', updateCategory);

/**
 * @route   PATCH /api/categories/:id/deactivate
 * @desc    Desactivar una categoría
 * @access  Private
 */
router.patch('/:id/deactivate', deactivateCategory);

/**
 * @route   DELETE /api/categories/:id
 * @desc    Eliminar categoría permanentemente
 * @access  Private
 */
router.delete('/:id', deleteCategoryPermanently);

module.exports = router;