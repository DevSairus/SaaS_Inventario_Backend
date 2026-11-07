// backend/src/routes/attachments.routes.js
// Adjuntos de documentos. Base: /api/attachments (ver controllers/attachments.controller.js)
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/attachments.controller');
const uploadAttachment = require('../middleware/uploadAttachment');
const { requirePermission } = require('../middleware/requirePermission');
const { keepTenantContext } = require('../middleware/keepTenantContext');

// Errores de multer (tamaño, tipo) como 400 con mensaje legible.
const single = (req, res, next) => keepTenantContext(uploadAttachment.single('file'))(req, res, (err) => {
  if (!err) return next();
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera 10 MB' : err.message;
  return res.status(400).json({ success: false, message });
});

router.get('/', ctrl.list);
router.post('/', requirePermission('attachments.write'), single, ctrl.upload);
router.get('/:id/download', ctrl.download);
router.delete('/:id', ctrl.remove);

module.exports = router;
