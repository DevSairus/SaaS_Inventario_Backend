// backend/src/routes/ensambladora/ciclovida.routes.js
const express = require('express');
const {
  crearVenta,
  crearAlistamiento,
  listarAlistamientosPorVin,
  crearEntrega,
  listarEntregasPorVin,
  crearRevision,
} = require('../../controllers/ensambladora/ciclovida.controller');
const {
  generarShareTokenRevision,
  generarPdfRevision,
} = require('../../controllers/ensambladora/comprobantes.controller');
const { crearCotizacion, generarPdf: generarPdfCotizacion } = require('../../controllers/ensambladora/cotizaciones.controller');
// Mismo middleware ya usado para fotos en el resto del sistema (memoryStorage,
// listo para subir a Cloudinary) -- el front de entregas manda multipart
// cuando hay evidenciaFile (ver ensambladoraEntregasApi.create).
const uploadImage = require('../../middleware/uploadImage');

const { requireEnsSales, requireEnsOperation } = require('./_roles');

const router = express.Router();

router.post('/ventas', requireEnsSales, crearVenta);
router.get('/alistamientos', listarAlistamientosPorVin);
router.post('/alistamientos', requireEnsOperation, crearAlistamiento);
// Sin este middleware, un POST multipart llega con req.body vacío -- por
// eso fallaba "vin y fecha_entrega son obligatorios" aunque el front sí
// los mandara: nunca se estaban parseando.
router.get('/entregas', listarEntregasPorVin);
router.post('/entregas', requireEnsOperation, uploadImage.single('evidencia'), crearEntrega);
router.post('/revisiones', requireEnsOperation, crearRevision);
router.post('/revisiones/:id/share-token', requireEnsOperation, generarShareTokenRevision);
router.get('/revisiones/:id/pdf', generarPdfRevision);
router.post('/cotizaciones', requireEnsOperation, crearCotizacion);
router.get('/cotizaciones/:id/pdf', generarPdfCotizacion);

module.exports = router;