const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/vehicles.controller');
const { requirePermission } = require('../../middleware/requirePermission');

router.get('/', ctrl.list);
// Búsqueda exacta por placa (sin espacios/guiones) -- modal de OT rápida.
// Va antes de '/:id' para que 'by-plate' no se tome como id.
router.get('/by-plate/:plate', ctrl.getByPlate);
// Catálogo global de marcas/líneas por tipo de vehículo (antes de '/:id').
router.get('/catalog', ctrl.getCatalog);
router.get('/:id', ctrl.getById);
router.get('/:id/history', ctrl.getHistory);
// Portal del vehículo / mantenimientos (plan-portal-mantenimiento-vehiculo.md)
router.get('/:id/maintenance', ctrl.getMaintenance);
// Recordatorios de vencimiento SOAT / técnico-mecánica enviados
router.get('/:id/reminders', ctrl.getReminders);
router.post('/:id/portal-token', ctrl.getPortalLink);
router.post('/:id/portal-whatsapp', ctrl.sendPortalWhatsApp);
router.get('/:id/label', ctrl.getLabel);
// Hoja de vida 360 (services/workshop/vehicle360.service.js)
router.get('/:id/360', ctrl.get360);
router.get('/:id/owners', ctrl.getOwners);
router.post('/:id/owners', ctrl.transferOwner);
router.put('/:id/owners/:ownerId', requirePermission('workshop.vehicles.owners'), ctrl.updateOwner);
router.get('/:id/runt-snapshots', ctrl.listRuntSnapshots);
router.post('/:id/runt-snapshots', ctrl.saveRuntSnapshot);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
