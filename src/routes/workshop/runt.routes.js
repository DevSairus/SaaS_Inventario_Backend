// src/routes/workshop/runt.routes.js
//
// Rutas del proxy RUNT — se montan bajo /api/workshop/vehicles/runt
// Requieren autenticación (middleware auth aplicado desde server.js/router padre)

const express = require('express');
const router  = express.Router();
const ctrl    = require('../../controllers/workshop/runt.controller');

// GET  /workshop/vehicles/runt/captcha      → genera nuevo captcha
// POST /workshop/vehicles/runt/consultar    → consulta vehículo por placa + doc + captcha
router.get('/captcha',    ctrl.getCaptcha);
router.post('/consultar', ctrl.consultarVehiculo);

module.exports = router;