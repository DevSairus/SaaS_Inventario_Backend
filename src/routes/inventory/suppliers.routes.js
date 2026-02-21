const express = require('express');
const router = express.Router();
const suppliersController = require('../../controllers/inventory/suppliers.controller');

// Rutas de proveedores (autenticación aplicada en index.js principal)
router.get('/', suppliersController.getSuppliers);
router.get('/stats', suppliersController.getSupplierStats);
router.get('/:id', suppliersController.getSupplierById);
router.post('/', suppliersController.createSupplier);
router.put('/:id', suppliersController.updateSupplier);
router.patch('/:id/deactivate', suppliersController.deactivateSupplier);
router.patch('/:id/activate', suppliersController.activateSupplier);
router.delete('/:id', suppliersController.deleteSupplier);

module.exports = router;