// backend/src/routes/ensambladora/liquidaciones.routes.js
const express = require('express');
const {
  listarLiquidaciones,
  obtenerLiquidacion,
  tarifarioVigente,
  listarBoletines,
  politicasMantenimiento,
  catalogoPiezas,
  listarMarcas,
  listarLineas,
} = require('../../controllers/ensambladora/liquidaciones.controller');

const router = express.Router();

router.get('/liquidaciones', listarLiquidaciones);
router.get('/liquidaciones/:id', obtenerLiquidacion);
router.get('/tarifario', tarifarioVigente);
router.get('/boletines', listarBoletines);
// Formulario de mantenimiento en taller (ver
// requerimientos-pitbox-formulario-mantenimiento.md, secciones 1.1bis/1.3).
router.get('/politicas-mantenimiento', politicasMantenimiento);
router.get('/catalogo-piezas', catalogoPiezas);
// Selectores de "Cotizar" (CotizarPage.jsx) -- no parten de un VIN.
router.get('/marcas', listarMarcas);
router.get('/lineas', listarLineas);

module.exports = router;
