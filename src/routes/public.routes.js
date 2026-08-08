// backend/src/routes/public.routes.js
// Rutas públicas — sin autenticación.
// Solo exponen datos seguros para el cliente final.
const express = require('express');
const router = express.Router();
const { getPublicOrder, respondQuoteRequest } = require('../controllers/workshop/workOrders.controller');
const { getPublicComprobante } = require('../controllers/ensambladora/comprobantes.controller');
const { quoteResponseLimiter } = require('../middleware/rateLimiter');

// GET /api/public/work-orders/:token
// El cliente consulta el estado de su OT con el token compartido por WhatsApp.
router.get('/work-orders/:token', getPublicOrder);

// GET /api/public/ensambladora/comprobantes/:tipo/:token (tipo: revision|garantia)
// El cliente consulta el seguimiento de su revisión/garantía sin autenticarse.
router.get('/ensambladora/comprobantes/:tipo/:token', getPublicComprobante);

// POST /api/public/work-orders/:token/quote-requests/:quoteRequestId/respond
// El cliente aprueba/rechaza los ítems de una ronda de cotización. Sin auth,
// por eso lleva rate limiting — ver quoteResponseLimiter.
router.post('/work-orders/:token/quote-requests/:quoteRequestId/respond', quoteResponseLimiter, respondQuoteRequest);

module.exports = router;