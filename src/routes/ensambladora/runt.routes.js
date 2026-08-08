// backend/src/routes/ensambladora/runt.routes.js
const express = require('express');
const { solicitarReporte } = require('../../controllers/ensambladora/runt.controller');

const router = express.Router();

router.post('/solicitudes', solicitarReporte);

module.exports = router;
