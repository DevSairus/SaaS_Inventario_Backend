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
const { getPublicVehiclePortal } = require('../controllers/workshop/vehicles.controller');
const { quoteResponseLimiter, appointmentBookingLimiter, vehiclePortalLimiter, consentLimiter } = require('../middleware/rateLimiter');
const {
  getPublicConsent, sendPublicOtp, acceptPublic, rejectPublic, getPublicPdf,
} = require('../controllers/legal/consents.controller');
const { getPublicPosts, getPublicPostBySlug } = require('../controllers/public/blog.controller');
const { getPublicOrderListPdf } = require('../controllers/inventory/orderLists.controller');
const approvalsCtrl = require('../controllers/approvals.controller');

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

// GET /api/public/vehicles/:token
// Portal del vehículo (hoja de vida + próximo mantenimiento). El token va
// impreso en el sticker QR -- ver getPublicVehiclePortal.
router.get('/vehicles/:token', vehiclePortalLimiter, getPublicVehiclePortal);

// ── Citas de Taller ──────────────────────────────────────────────────────
// Sin token previo posible (primera vez que aparece el cliente) -- el
// tenant se resuelve por Tenant.slug, no por share_token. Ver
// resolveTenantSchemaBySlug en workshopAppointments.controller.js.
router.get('/workshop/:slug/branches', getPublicBranches);
router.get('/workshop/:slug/:branchId/config', getPublicConfig);
router.get('/workshop/:slug/:branchId/availability', getPublicAvailability);
router.post('/workshop/:slug/:branchId/appointments', appointmentBookingLimiter, createPublicAppointment);
router.get('/workshop/appointments/:token', getPublicAppointmentStatus);

// ── Autorizaciones del cliente (habeas data / acta de ingreso) ──────────
// El cliente lee el documento, pide un OTP (email o WhatsApp) y lo confirma.
// Ver services/legal/consent.service.js.
router.get('/consents/:token', consentLimiter, getPublicConsent);
router.post('/consents/:token/otp', consentLimiter, sendPublicOtp);
router.post('/consents/:token/accept', consentLimiter, acceptPublic);
router.post('/consents/:token/reject', consentLimiter, rejectPublic);
router.get('/consents/:token/pdf', consentLimiter, getPublicPdf);

// ── Pedido a proveedor (PDF compartido por WhatsApp) ─────────────────────
// GET /api/public/order-lists/:token/pdf — ver orderLists.controller.js.
router.get('/order-lists/:token/pdf', consentLimiter, getPublicOrderListPdf);

// ── Aprobación desde el correo (enlace de un solo uso) ───────────────────
// Ver services/approvals/approvals.service.js.
router.get('/approvals/:token', consentLimiter, approvalsCtrl.publicView);
router.post('/approvals/:token', consentLimiter, approvalsCtrl.publicDecide);

// ── Blog editorial (SEO) ─────────────────────────────────────────────────
// GET /api/public/blog — listado paginado de artículos publicados.
// GET /api/public/blog/:slug — un artículo + hasta 3 relacionados.
// Simulador solar público por empresa (módulo Proyectos). Ver services/solar/solarPublic.service.js.
const solarPublic = require('../services/solar/solarPublic.service');
const { solarPublicLimiter, solarLeadLimiter, solarOcrLimiter } = require('../middleware/rateLimiter');
const solarBillUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
const solarHandle = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    require('../config/logger').error(`[solar-public] ${req.path}: ${error.message}`, { stack: error.stack });
    return res.status(500).json({ success: false, message: 'No pudimos calcular en este momento. Intenta de nuevo.' });
  }
};
const solarMeta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'], referrer: req.body?.referrer || req.headers.referer });
router.get('/solar/:slug/config', solarPublicLimiter, solarHandle((req) => solarPublic.config(req.params.slug)));
router.get('/solar/:slug/geocode', solarPublicLimiter, solarHandle(async (req) => {
  await solarPublic.config(req.params.slug); // solo empresas con el simulador activo
  return require('../services/solar/solar.service').geocode(req.query.q);
}));
router.get('/solar/:slug/irradiance', solarPublicLimiter, solarHandle(async (req) => {
  await solarPublic.config(req.params.slug);
  return require('../services/solar/solar.service').irradiance(req.query.lat, req.query.lon);
}));
router.post('/solar/:slug/estimate', solarPublicLimiter, solarHandle((req) => solarPublic.estimate(req.params.slug, req.body || {})));
router.post('/solar/:slug/lead', solarLeadLimiter, solarHandle((req) => solarPublic.createLead(req.params.slug, req.body || {}, solarMeta(req))));
router.post('/solar/:slug/bill', solarOcrLimiter, solarBillUpload.single('file'), solarHandle((req) => solarPublic.readBill(req.params.slug, req.file, req.body || {}, solarMeta(req))));

router.get('/blog', getPublicPosts);
router.get('/blog/:slug', getPublicPostBySlug);

module.exports = router;