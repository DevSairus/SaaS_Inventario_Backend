const express = require('express');
const router = express.Router();

const {
  getAllProducts,
  getProductById,
  getProductSuppliers,
  createProduct,
  updateProduct,
  deactivateProduct,
  deleteProductPermanently,
  getProductStats,
  getProductByBarcode,
  checkBarcodeExists
} = require('../../controllers/inventory/products.controller');

const { authMiddleware } = require('../../middleware/auth');

router.use(authMiddleware);

// Estadísticas
router.get('/stats', getProductStats);

// Búsqueda por código de barras
router.get('/barcode/:barcode', getProductByBarcode);
router.get('/check-barcode/:barcode', checkBarcodeExists);

// CRUD básico
router.get('/', getAllProducts);
router.get('/:id', getProductById);
router.post('/', createProduct);
router.put('/:id', updateProduct);
router.patch('/:id/deactivate', deactivateProduct);
router.delete('/:id', deleteProductPermanently);

// Proveedores por producto (para stock alerts)
router.get('/:id/suppliers', getProductSuppliers);

module.exports = router;