const express = require('express');
const router = express.Router();
const suppliersController = require('../../controllers/inventory/suppliers.controller');
const { checkRole } = require('../../middleware/auth');

// INV-4: altas/bajas de proveedores. Contador incluido porque gestiona CxP.
const SUPPLIERS_WRITE_ROLES = ['admin', 'manager', 'warehouse_keeper', 'accountant', 'super_admin'];

// Rutas de proveedores (autenticación aplicada en index.js principal)
router.get('/', suppliersController.getSuppliers);
router.get('/stats', suppliersController.getSupplierStats);
router.get('/:id', suppliersController.getSupplierById);
router.post('/', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.createSupplier);
router.put('/:id', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.updateSupplier);
router.patch('/:id/deactivate', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.deactivateSupplier);
router.patch('/:id/activate', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.activateSupplier);
router.delete('/:id', checkRole(...SUPPLIERS_WRITE_ROLES), suppliersController.deleteSupplier);

module.exports = router;