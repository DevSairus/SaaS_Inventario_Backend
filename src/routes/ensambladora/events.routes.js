// backend/src/routes/ensambladora/events.routes.js
const express = require('express');
const { listEvents } = require('../../controllers/ensambladora/sync.controller');

const router = express.Router();

router.get('/events', listEvents);

module.exports = router;
