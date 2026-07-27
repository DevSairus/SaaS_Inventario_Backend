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
  checkBarcodeExists,
  uploadProductImage,
  deleteProductImage
} = require('../../controllers/inventory/products.controller');

const {
  getProductEquivalents,
  addToEquivalenceGroup,
  removeFromEquivalenceGroup,
  searchEquivalenceGroups,
  updateMember,
  batchCheckEquivalents
} = require('../../controllers/inventory/equivalences.controller');

const {
  getProductVehicleApplications,
  addVehicleApplication,
  updateVehicleApplication,
  removeVehicleApplication,
  getBrandsAndLines,
  getOrCreateBrandAndLine
} = require('../../controllers/inventory/vehicleApplications.controller');

const uploadProductImageMiddleware = require('../../middleware/uploadProductImage');

const { authMiddleware } = require('../../middleware/auth');
const { branchMiddleware } = require('../../middleware/branch');

router.use(authMiddleware);

// Estadísticas
router.get('/stats', getProductStats);

// Búsqueda por código de barras
router.get('/barcode/:barcode', getProductByBarcode);
router.get('/check-barcode/:barcode', checkBarcodeExists);

// Búsqueda de grupos de equivalencia (antes de /:id para evitar conflicto)
router.get('/equivalence-groups', searchEquivalenceGroups);

// Batch check de equivalentes (antes de /:id)
router.post('/equivalents/batch-check', batchCheckEquivalents);

// Marcas y líneas para autocompletado (antes de /:id)
router.get('/vehicle-brands-lines', getBrandsAndLines);
router.post('/vehicle-brands-lines', getOrCreateBrandAndLine);

// CRUD básico
// branchMiddleware solo en el listado/búsqueda: getAllProducts filtra por las
// bodegas de la sede activa (req.branch_id). El resto de endpoints (crear,
// editar, código de barras, etc.) no requieren sede resuelta.
router.get('/', branchMiddleware, getAllProducts);
router.get('/:id', getProductById);
router.post('/', createProduct);
router.put('/:id', updateProduct);
router.patch('/:id/deactivate', deactivateProduct);
router.delete('/:id', deleteProductPermanently);

// Proveedores por producto (para stock alerts)
router.get('/:id/suppliers', getProductSuppliers);

// Equivalencias por producto
router.get('/:id/equivalents', getProductEquivalents);
router.post('/:id/equivalents', addToEquivalenceGroup);
router.delete('/:id/equivalents/:groupId', removeFromEquivalenceGroup);
router.put('/:id/equivalents/:groupId/member/:memberId', updateMember);

// Aplicaciones vehiculares por producto
router.get('/:id/vehicle-applications', getProductVehicleApplications);
router.post('/:id/vehicle-applications', addVehicleApplication);
router.put('/:id/vehicle-applications/:appId', updateVehicleApplication);
router.delete('/:id/vehicle-applications/:appId', removeVehicleApplication);

// Imagen del producto
router.post('/:id/image', uploadProductImageMiddleware.single('image'), uploadProductImage);
router.delete('/:id/image', deleteProductImage);

module.exports = router;