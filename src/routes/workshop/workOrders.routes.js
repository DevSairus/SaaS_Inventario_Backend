const express = require('express');
const router = express.Router();
const multer = require('multer');
const ctrl = require('../../controllers/workshop/workOrders.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB por foto
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'), false);
  }
});

router.get('/productivity', ctrl.productivity);
router.get('/', ctrl.list);
router.get('/:id/pdf', ctrl.generatePDF);
router.get('/:id', ctrl.getById);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.patch('/:id/status', ctrl.changeStatus);
router.patch('/:id/checklist', ctrl.updateChecklist);

// Ítems
router.post('/:id/items', ctrl.addItem);
router.delete('/:id/items/:itemId', ctrl.removeItem);

// Generar remisión
router.post('/:id/generate-sale', ctrl.generateSale);

// Fotos
router.post('/:id/photos/:phase', upload.array('photos', 10), ctrl.uploadPhotos);
router.delete('/:id/photos/:phase/:photoIndex', ctrl.deletePhoto);

module.exports = router;