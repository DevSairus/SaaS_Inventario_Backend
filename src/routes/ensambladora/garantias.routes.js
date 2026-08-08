// backend/src/routes/ensambladora/garantias.routes.js
const express = require('express');
const {
  crearGarantia,
  cerrarGarantia,
  listarPorVin,
  listarTodas,
  obtenerDetalle,
  reenviarGarantia,
} = require('../../controllers/ensambladora/garantias.controller');
const {
  generarShareTokenGarantia,
  generarPdfGarantia,
} = require('../../controllers/ensambladora/comprobantes.controller');
// upload.any() porque las fotos de evidencia llegan en campos dinámicos
// evidencia_0, evidencia_1... (uno por item, no todos los items tienen
// foto) -- ver crearGarantia.
const uploadImage = require('../../middleware/uploadImage');

const router = express.Router();

router.get('/todas', listarTodas);
router.get('/', listarPorVin);
router.post('/', uploadImage.any(), crearGarantia);
router.post('/:id/cerrar', cerrarGarantia);
router.post('/:id/reenviar', uploadImage.any(), reenviarGarantia);
router.post('/:id/share-token', generarShareTokenGarantia);
router.get('/:id/pdf', generarPdfGarantia);
router.get('/:id', obtenerDetalle);

module.exports = router;
