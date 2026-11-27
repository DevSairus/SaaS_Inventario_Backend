// backend/src/routes/workshop/inspections.routes.js
//
// Peritajes vehiculares. Base: /api/workshop/inspections
// (requireModule('workshop') en server.js).
//   Ver y descargar el PDF: cualquier usuario del taller.
//   Crear, diligenciar, subir fotos y finalizar: 'workshop.inspections.write'.
//   Anular un peritaje finalizado: 'workshop.inspections.cancel'.
//   Plantillas: 'workshop.inspections.templates'.
//   Facturar y enviar por WhatsApp: 'workshop.inspections.write'.

const express = require('express');
const multer = require('multer');
const router = express.Router();
const ctrl = require('../../controllers/workshop/inspections.controller');
const { requirePermission } = require('../../middleware/requirePermission');
const { requireModule } = require('../../middleware/checkModule');

const write = requirePermission('workshop.inspections.write');
const cancel = requirePermission('workshop.inspections.cancel');
const templates = requirePermission('workshop.inspections.templates');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'), false);
  },
});

router.get('/meta', ctrl.meta);
router.get('/templates', ctrl.listTemplates);
router.post('/templates', templates, ctrl.createTemplate);
router.put('/templates/:id', templates, ctrl.updateTemplate);

router.get('/', ctrl.list);
router.post('/', write, ctrl.create);
router.get('/:id', ctrl.getById);
router.put('/:id', write, ctrl.update);
router.get('/:id/pdf', ctrl.pdf);
router.post('/:id/finalize', write, ctrl.finalize);
router.post('/:id/cancel', cancel, ctrl.cancel);
router.delete('/:id', write, ctrl.remove);
router.post('/:id/photos', write, upload.array('photos', 10), ctrl.uploadPhotos);
// Facturar: crea una venta en borrador (requiere el módulo de Ventas).
router.get('/:id/billing', write, requireModule('sales'), ctrl.billingDefaults);
router.post('/:id/sale', write, requireModule('sales'), ctrl.createSale);
router.post('/:id/whatsapp', write, ctrl.sendWhatsApp);

module.exports = router;
