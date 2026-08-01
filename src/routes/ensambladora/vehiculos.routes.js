// backend/src/routes/ensambladora/vehiculos.routes.js
const express = require('express');
const { buscarPorVin, validarDisponibilidad } = require('../../controllers/ensambladora/vehiculos.controller');

const router = express.Router();

router.get('/:vin', buscarPorVin);
router.post('/:vin/validar-disponibilidad', validarDisponibilidad);

module.exports = router;
