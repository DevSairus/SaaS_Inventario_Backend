// backend/src/routes/ensambladora/events.routes.js
const express = require('express');
const { listEvents, reintentarEvento, marcarRevisado } = require('../../controllers/ensambladora/sync.controller');

const router = express.Router();

router.get('/events', listEvents);
router.post('/events/:id/reintentar', reintentarEvento);
router.post('/events/:id/marcar-revisado', marcarRevisado);

module.exports = router;
