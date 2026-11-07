const express = require('express');
const router = express.Router();
const suppliersController = require('../../controllers/inventory/suppliers.controller');
const { checkRole } = require('../../middleware/auth');
const thirdPartyImport = require('../../controllers/thirdPartyImport.controller');
const uploadExcel = require('../../middleware/uploadProductsExcel');
const { keepTenantContext } = require('../../middleware/keepTenantContext');

// INV-4: altas/bajas de proveedores. Contador incluido porque gestiona CxP.
const SUPPLIERS_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'accountant', 'super_admin'];

// Rutas de proveedores (autenticación aplicada en index.js principal)
router.get('/import/template', thirdPartyImport.template('suppliers'));
router.post('/import', checkRole(...SUPPLIERS_WRITE_ROLES), keepTenantContext(uploadExcel.single('archivo')), thirdPartyImport.importFile('suppliers'));
router.get('/', suppliersController.getSuppliers);
router.get('/stats', suppliersController.getSupplierStats);
router.get('/:id', suppliersController.getSupplierById);
router.post('/', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.createSupplier);
router.put('/:id', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.updateSupplier);
router.patch('/:id/deactivate', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.deactivateSupplier);
router.patch('/:id/activate', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.activateSupplier);
router.delete('/:id', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.deleteSupplier);

module.exports = router;