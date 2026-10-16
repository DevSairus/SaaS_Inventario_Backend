// backend/src/routes/ensambladora/vehiculos.routes.js
const express = require('express');
const { buscarPorVin, buscarPorPlaca, matricularVehiculo, validarDisponibilidad, atenderRecall, agendaRevisiones } = require('../../controllers/ensambladora/vehiculos.controller');

const { requireEnsMgmt, requireEnsSales } = require('./_roles');

const router = express.Router();

// 'agenda-revisiones' y 'buscar' tienen que ir ANTES de '/:vin', si no
// Express los interpreta como un VIN (mismo cuidado que
// /pendientes-revision en el Core).
router.get('/agenda-revisiones', agendaRevisiones);
router.get('/buscar', buscarPorPlaca);
router.get('/:vin', buscarPorVin);
router.post('/:vin/matricular', requireEnsSales, matricularVehiculo);
router.post('/:vin/validar-disponibilidad', requireEnsSales, validarDisponibilidad);
router.post('/:vin/recalls/:campanaId/atender', requireEnsMgmt, atenderRecall);

module.exports = router;
