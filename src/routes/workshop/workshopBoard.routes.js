const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/workshop/workshopBoard.controller');
const { checkRole } = require('../../middleware/auth');

// Tablero (solo lectura): cualquier usuario con acceso a Taller.
router.get('/', ctrl.getBoard);
router.get('/bays', ctrl.listBays);

// Configurar bahías y el enlace del TV: admin/manager, mismo criterio que la
// configuración de citas (appointments.routes.js).
router.post('/bays', checkRole('admin', 'manager'), ctrl.createBay);
router.put('/bays/:id', checkRole('admin', 'manager'), ctrl.updateBay);
router.delete('/bays/:id', checkRole('admin', 'manager'), ctrl.deleteBay);
router.get('/display', checkRole('admin', 'manager'), ctrl.getDisplay);
router.post('/display', checkRole('admin', 'manager'), ctrl.regenerateDisplay);
router.delete('/display', checkRole('admin', 'manager'), ctrl.revokeDisplay);

module.exports = router;
