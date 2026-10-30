const express = require('express');
const router = express.Router();

const {
  getAllProducts,
  getProductById,
  getProductInProcess,
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

const { bulkImportProducts } = require('../../controllers/inventory/productsBulkImport.controller');
const { getMargins, previewMargin, applyMargin, updateMarginMethod } = require('../../controllers/inventory/productMargins.controller');

const uploadProductImageMiddleware = require('../../middleware/uploadProductImage');
const uploadProductsExcelMiddleware = require('../../middleware/uploadProductsExcel');

const { authMiddleware, checkRole } = require('../../middleware/auth');
const { branchMiddleware } = require('../../middleware/branch');

router.use(authMiddleware);

// Crear/modificar productos (precio incluido) solo gerencia y bodeguero; antes
// cualquier usuario autenticado podía hacerlo por API. Las consultas siguen
// abiertas porque Ventas y Taller las necesitan.
const PRODUCTS_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'super_admin'];

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
router.post('/vehicle-brands-lines', checkRole(...PRODUCTS_WRITE_ROLES), getOrCreateBrandAndLine);

// Carga masiva de productos por Excel, incluye equivalencias por código (antes de /:id)
// Márgenes de ganancia por categoría / global. Cambiarlos puede mover el
// precio de cientos de productos a la vez: solo gerencia.
const MARGINS_WRITE_ROLES = ['admin', 'manager', 'super_admin'];
router.get('/margins', getMargins);
router.post('/margins/preview', checkRole(...MARGINS_WRITE_ROLES), previewMargin);
router.post('/margins/apply', checkRole(...MARGINS_WRITE_ROLES), applyMargin);
router.put('/margins/method', checkRole(...MARGINS_WRITE_ROLES), updateMarginMethod);

router.post('/bulk-import', checkRole(...PRODUCTS_WRITE_ROLES), uploadProductsExcelMiddleware.single('archivo'), bulkImportProducts);

// CRUD básico
// branchMiddleware solo en el listado/búsqueda: getAllProducts filtra por las
// bodegas de la sede activa (req.branch_id). El resto de endpoints (crear,
// editar, código de barras, etc.) no requieren sede resuelta.
router.get('/', branchMiddleware, getAllProducts);
router.get('/:id', getProductById);
router.post('/', checkRole(...PRODUCTS_WRITE_ROLES), createProduct);
router.put('/:id', checkRole(...PRODUCTS_WRITE_ROLES), updateProduct);
router.patch('/:id/deactivate', checkRole(...PRODUCTS_WRITE_ROLES), deactivateProduct);
router.delete('/:id', checkRole(...PRODUCTS_WRITE_ROLES), deleteProductPermanently);

// Proveedores por producto (para stock alerts)
router.get('/:id/suppliers', getProductSuppliers);

// Cantidad en trámite: documentos (ventas en borrador / OT) que comprometen este producto
router.get('/:id/in-process', getProductInProcess);

// Equivalencias por producto
router.get('/:id/equivalents', getProductEquivalents);
router.post('/:id/equivalents', checkRole(...PRODUCTS_WRITE_ROLES), addToEquivalenceGroup);
router.delete('/:id/equivalents/:groupId', checkRole(...PRODUCTS_WRITE_ROLES), removeFromEquivalenceGroup);
router.put('/:id/equivalents/:groupId/member/:memberId', checkRole(...PRODUCTS_WRITE_ROLES), updateMember);

// Aplicaciones vehiculares por producto
router.get('/:id/vehicle-applications', getProductVehicleApplications);
router.post('/:id/vehicle-applications', checkRole(...PRODUCTS_WRITE_ROLES), addVehicleApplication);
router.put('/:id/vehicle-applications/:appId', checkRole(...PRODUCTS_WRITE_ROLES), updateVehicleApplication);
router.delete('/:id/vehicle-applications/:appId', checkRole(...PRODUCTS_WRITE_ROLES), removeVehicleApplication);

// Imagen del producto
router.post('/:id/image', checkRole(...PRODUCTS_WRITE_ROLES), uploadProductImageMiddleware.single('image'), uploadProductImage);
router.delete('/:id/image', checkRole(...PRODUCTS_WRITE_ROLES), deleteProductImage);

module.exports = router;