// backend/src/routes/ensambladora/runt.routes.js
const express = require('express');
const { solicitarReporte } = require('../../controllers/ensambladora/runt.controller');

const { requireEnsSales } = require('./_roles');

const router = express.Router();

router.post('/solicitudes', requireEnsSales, solicitarReporte);

module.exports = router;
