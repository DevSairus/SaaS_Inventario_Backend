// backend/src/routes/metaWebhook.routes.js
// Ruta pública (sin authMiddleware) -- Meta no manda un JWT de Pitbox, se
// autentica por firma HMAC (X-Hub-Signature-256, ver metaClient.verificarFirmaWebhook)
// más el handshake GET de hub.verify_token. Mismo patrón que ncfWebhook.routes.js.
const express = require('express');
const router = express.Router();
const { handleVerify, handleWebhook } = require('../controllers/metaWebhook.controller');
const { handleOwnCallback } = require('../controllers/crm/metaIntegration.controller');

router.get('/', handleVerify);
router.post('/', handleWebhook);

// Callback del diálogo OAuth "cuenta propia" -- ver metaIntegration.controller.js
router.get('/oauth-callback', handleOwnCallback);

module.exports = router;
