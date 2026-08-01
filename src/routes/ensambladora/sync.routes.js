// backend/src/routes/ensambladora/sync.routes.js
// Ruta pública (sin authMiddleware) -- el Core Ensambladora no manda un JWT
// de Pitbox, se autentica por X-Api-Key + X-Signature. Mismo patrón que
// metaWebhook.routes.js / ncfWebhook.routes.js.
const express = require('express');
const { verifySyncAuth } = require('../../middleware/ensambladora/verifySyncAuth');
const { receiveInbound } = require('../../controllers/ensambladora/sync.controller');

const router = express.Router();

router.post('/inbound', verifySyncAuth, receiveInbound);

module.exports = router;
