// backend/src/routes/public.routes.js
// Rutas públicas — sin autenticación.
// Solo exponen datos seguros para el cliente final.
const express = require('express');
const router = express.Router();
const { getPublicOrder } = require('../controllers/workshop/workOrders.controller');

// GET /api/public/work-orders/:token
// El cliente consulta el estado de su OT con el token compartido por WhatsApp.
router.get('/work-orders/:token', getPublicOrder);

module.exports = router;