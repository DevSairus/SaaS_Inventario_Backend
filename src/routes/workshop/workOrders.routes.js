const express = require('express');
const router = express.Router();
const multer = require('multer');
const ctrl = require('../../controllers/workshop/workOrders.controller');
const { checkAccountOwnership } = require('../../middleware/checkAccountOwnership');
const { checkRole } = require('../../middleware/auth');
const { requireModule } = require('../../middleware/checkModule');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (video de OT necesita más que una foto)
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes o videos'), false);
  }
});

router.get('/report', ctrl.getReport);
router.get('/productivity', ctrl.productivity);
router.get('/', ctrl.list);
router.get('/:id/pdf', ctrl.generatePDF);
router.get('/:id', ctrl.getById);
router.post('/', checkAccountOwnership, ctrl.create);
router.put('/:id', ctrl.update);
router.patch('/:id/status', ctrl.changeStatus);
router.patch('/:id/checklist', ctrl.updateChecklist);

// Convertir cotización (sales.document_type='cotizacion') en OT — solo
// tenants con módulo Taller (ya validado a nivel de app.use en server.js,
// pero se repite acá el checkRole porque no toda persona con acceso a
// Taller debería poder cerrar cotizaciones ajenas de venta).
router.post('/from-quote/:saleId', requireModule('workshop'), checkRole('seller', 'technician', 'manager', 'admin', 'super_admin'), ctrl.convertQuoteToWorkOrder);

// Ítems
router.post('/:id/items', ctrl.addItem);
router.delete('/:id/items/:itemId', ctrl.removeItem);

// Cotización con aprobación del cliente
router.post('/:id/quote-requests', ctrl.sendQuoteRequest);
router.post('/:id/quote-requests/:quoteRequestId/apply', ctrl.applyApprovedItems);

// Generar remisión
router.post('/:id/generate-sale', ctrl.generateSale);

// Pagos / abonos
router.get('/:id/payments', ctrl.getPaymentHistory);
router.post('/:id/payments', ctrl.registerPayment);

// Fotos
router.post('/:id/photos/:phase', upload.array('photos', 10), ctrl.uploadPhotos);
router.delete('/:id/photos/:phase/:photoIndex', ctrl.deletePhoto);

// Diagramas interactivos de intervención — "hoja de inspección" del técnico
router.get('/:id/diagnosis-marks', ctrl.listDiagnosisMarks);
router.post('/:id/diagnosis-marks', ctrl.addDiagnosisMark);
router.put('/:id/diagnosis-marks/:markId', ctrl.updateDiagnosisMark);
router.delete('/:id/diagnosis-marks/:markId', ctrl.removeDiagnosisMark);
router.post('/:id/diagnosis-marks/generate-items', ctrl.generateItemsFromMarks);

// Compartir por WhatsApp (link público)
router.post('/:id/share-token', ctrl.generateShareToken);

// Enviar enlace OT por WhatsApp (wa.me)
router.post('/:id/send-whatsapp', ctrl.sendWhatsApp);

module.exports = router;