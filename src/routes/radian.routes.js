// backend/src/routes/radian.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/radian/radian.controller');

router.post('/purchases/:id/acuse',      ctrl.emitAcuse);
router.post('/purchases/:id/recibo',     ctrl.emitRecibo);
router.post('/purchases/:id/aceptacion', ctrl.emitAceptacion);
router.post('/purchases/:id/reclamo',    ctrl.emitReclamo);
router.get('/purchases/:id/events',      ctrl.getEvents);

router.post('/sales/:id/received-event',      ctrl.recordSaleEvent);
router.post('/sales/:id/aceptacion-tacita',   ctrl.emitTacita);
router.get('/sales/:id/events',               ctrl.getSaleEvents);

// Fase 4 — requiere factura inscrita (ver radianService.js)
router.post('/sales/:id/inscripcion',          ctrl.emitInscripcion);
router.post('/sales/:id/endoso',               ctrl.emitEndoso);
router.post('/sales/:id/cancelar-endoso',      ctrl.emitCancelacionEndoso);
router.post('/sales/:id/limitacion',           ctrl.emitLimitacion);
router.post('/sales/:id/terminar-limitacion',  ctrl.emitTerminarLimitacion);
router.post('/sales/:id/mandato',              ctrl.emitMandato);
router.post('/sales/:id/terminar-mandato',     ctrl.emitTerminarMandato);
router.post('/sales/:id/pago',                 ctrl.emitPago);
router.post('/sales/:id/informe-pago',         ctrl.emitInformePago);

router.get('/pending', ctrl.getPending);

module.exports = router;
