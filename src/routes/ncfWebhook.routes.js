// backend/src/routes/ncfWebhook.routes.js
// Ruta pública (sin authMiddleware) -- el Núcleo no tiene un JWT de Pitbox,
// se autentica por firma HMAC (ver ncfClient.verificarFirmaWebhook). Mismo
// patrón que cualquier webhook de un proveedor externo (MercadoPago, etc).
const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/ncfWebhook.controller');

router.post('/', handleWebhook);

module.exports = router;
