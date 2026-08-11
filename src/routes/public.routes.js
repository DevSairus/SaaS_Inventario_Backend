// backend/src/routes/public.routes.js
// Rutas públicas — sin autenticación.
// Solo exponen datos seguros para el cliente final.
const express = require('express');
const router = express.Router();
const { getPublicOrder, respondQuoteRequest } = require('../controllers/workshop/workOrders.controller');
const { getPublicComprobante } = require('../controllers/ensambladora/comprobantes.controller');
const { getPublicSale, respondPublicQuote } = require('../controllers/sales/sales.controller');
const {
  getPublicBranches, getPublicConfig, getPublicAvailability,
  createPublicAppointment, getPublicAppointmentStatus,
} = require('../controllers/workshop/workshopAppointments.controller');
const { quoteResponseLimiter, appointmentBookingLimiter } = require('../middleware/rateLimiter');

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

// GET /api/public/sales/:token
// El cliente consulta su cotización (detalle + estado) con el token
// compartido por WhatsApp.
router.get('/sales/:token', getPublicSale);

// POST /api/public/sales/:token/respond
// El cliente aprueba/rechaza la cotización. Sin auth, por eso lleva rate
// limiting — ver quoteResponseLimiter.
router.post('/sales/:token/respond', quoteResponseLimiter, respondPublicQuote);

// ── Citas de Taller ──────────────────────────────────────────────────────
// Sin token previo posible (primera vez que aparece el cliente) -- el
// tenant se resuelve por Tenant.slug, no por share_token. Ver
// resolveTenantSchemaBySlug en workshopAppointments.controller.js.
router.get('/workshop/:slug/branches', getPublicBranches);
router.get('/workshop/:slug/:branchId/config', getPublicConfig);
router.get('/workshop/:slug/:branchId/availability', getPublicAvailability);
router.post('/workshop/:slug/:branchId/appointments', appointmentBookingLimiter, createPublicAppointment);
router.get('/workshop/appointments/:token', getPublicAppointmentStatus);

module.exports = router;