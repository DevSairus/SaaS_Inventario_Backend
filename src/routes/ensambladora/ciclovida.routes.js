// backend/src/routes/ensambladora/ciclovida.routes.js
const express = require('express');
const { crearVenta, crearAlistamiento, crearEntrega } = require('../../controllers/ensambladora/ciclovida.controller');

const router = express.Router();

router.post('/ventas', crearVenta);
router.post('/alistamientos', crearAlistamiento);
router.post('/entregas', crearEntrega);

module.exports = router;
