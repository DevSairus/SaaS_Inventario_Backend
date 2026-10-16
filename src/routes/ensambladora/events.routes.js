// backend/src/routes/ensambladora/events.routes.js
const express = require('express');
const { listEvents, reintentarEvento, marcarRevisado } = require('../../controllers/ensambladora/sync.controller');

const { requireEnsMgmt } = require('./_roles');

const router = express.Router();

router.get('/events', listEvents);
router.post('/events/:id/reintentar', requireEnsMgmt, reintentarEvento);
router.post('/events/:id/marcar-revisado', requireEnsMgmt, marcarRevisado);

module.exports = router;
