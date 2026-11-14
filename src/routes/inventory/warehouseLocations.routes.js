// backend/src/routes/inventory/warehouseLocations.routes.js
//
// Ubicaciones físicas de bodega (req. 2.2). Base: /api/inventory/locations
// Consultar: cualquier usuario del tenant. Crear / editar / eliminar:
// permisos por empresa (config/permissions.catalog.js). Asignar la ubicación a
// productos es editar productos.

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../../middleware/requirePermission');
const ctrl = require('../../controllers/inventory/warehouseLocations.controller');

router.get('/', ctrl.list);
router.post('/', requirePermission('inventory.locations.create'), ctrl.create);
// Antes de '/:id'
router.post('/bulk', requirePermission('inventory.locations.create'), ctrl.bulkCreate);
router.post('/assign', requirePermission('inventory.products.edit'), ctrl.assign);
router.put('/:id', requirePermission('inventory.locations.edit'), ctrl.update);
router.delete('/:id', requirePermission('inventory.locations.delete'), ctrl.remove);

module.exports = router;
