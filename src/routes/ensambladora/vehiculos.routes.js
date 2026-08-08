// backend/src/routes/ensambladora/vehiculos.routes.js
const express = require('express');
const { buscarPorVin, buscarPorPlaca, matricularVehiculo, validarDisponibilidad, atenderRecall, agendaRevisiones } = require('../../controllers/ensambladora/vehiculos.controller');

const router = express.Router();

// 'agenda-revisiones' y 'buscar' tienen que ir ANTES de '/:vin', si no
// Express los interpreta como un VIN (mismo cuidado que
// /pendientes-revision en el Core).
router.get('/agenda-revisiones', agendaRevisiones);
router.get('/buscar', buscarPorPlaca);
router.get('/:vin', buscarPorVin);
router.post('/:vin/matricular', matricularVehiculo);
router.post('/:vin/validar-disponibilidad', validarDisponibilidad);
router.post('/:vin/recalls/:campanaId/atender', atenderRecall);

module.exports = router;
