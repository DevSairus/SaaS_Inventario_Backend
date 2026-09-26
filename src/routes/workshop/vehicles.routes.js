const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/vehicles.controller');

router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.get('/:id/history', ctrl.getHistory);
// Portal del vehículo / mantenimientos (plan-portal-mantenimiento-vehiculo.md)
router.get('/:id/maintenance', ctrl.getMaintenance);
router.post('/:id/portal-token', ctrl.getPortalLink);
router.post('/:id/portal-whatsapp', ctrl.sendPortalWhatsApp);
router.get('/:id/label', ctrl.getLabel);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
