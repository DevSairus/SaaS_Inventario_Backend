// backend/src/routes/consents.routes.js
// Autorizaciones del cliente: habeas data y acta de ingreso del vehículo.
// (autenticación y tenant aplicados en server.js)
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const c = require('../controllers/legal/consents.controller');
const uploadSupport = require('../middleware/uploadSupport');

// Registrar una autorización firmada en papel o revocar una aceptada
// cambia la evidencia legal: solo administración.
const SENSITIVE_ROLES = ['admin', 'manager', 'super_admin'];

router.get('/preview', c.previewDocument);
router.post('/preview', c.previewDocument);
router.get('/intake-checklist', c.getIntakeChecklist);
router.get('/customer/:customerId', c.getCustomerConsents);
router.post('/customer/:customerId/marketing-opt-out', c.marketingOptOut);
router.get('/work-order/:workOrderId', c.getWorkOrderConsents);

router.post('/', c.createRequest);
router.get('/:id', c.getRequest);
router.get('/:id/pdf', c.getPdf);
router.post('/:id/send-link', c.sendLink);
router.post('/:id/otp', c.sendOtpCounter);
router.post('/:id/verify', c.verifyCounter);
router.post('/:id/cancel', c.cancelRequest);
router.post('/:id/physical', checkRole(...SENSITIVE_ROLES), uploadSupport.single('document'), c.registerPhysical);
router.get('/:id/physical-document', c.getPhysicalDocument);
router.post('/:id/revoke', checkRole(...SENSITIVE_ROLES), c.revokeRequest);

module.exports = router;
