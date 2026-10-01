const express = require('express');
const router = express.Router();
const { checkRole } = require('../../middleware/auth');
const ctrl = require('../../controllers/workshop/diagramTemplates.controller');

router.get('/', ctrl.list);
// Activar/desactivar diagramas y asignar categorías adicionales (admin del taller)
router.put('/settings', checkRole('admin', 'super_admin'), ctrl.updateSettings);
router.get('/:id', ctrl.getById);
// Recalibrar puntos (herramienta de admin, tras subir la imagen WEBP real)
router.patch('/:id/points', checkRole('admin', 'super_admin'), ctrl.updatePoints);
// Setear la ruta de la imagen WEBP real (herramienta de admin)
router.patch('/:id/image', checkRole('admin', 'super_admin'), ctrl.updateImage);

module.exports = router;
