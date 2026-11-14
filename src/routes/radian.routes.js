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
router.post('/sales/:id/sync-dian',           ctrl.syncSaleEvents);   // GetStatusEvent: trae 032/033/031 del cliente

// Fase 4 (036-046: inscripción, endosos, limitación, mandato, pago) —
// DESACTIVADA por decisión de producto: Pitbox solo ofrece 030-034. Estos
// eventos exigen habilitarse como participante RADIAN (SARLAFT y
// certificación ISO). El código se conserva; para reactivarla, quitar
// `faseNoDisponible` de estas rutas y volver a mostrar SaleCirculationPanel
// en SaleDetailPage.jsx.
const faseNoDisponible = (req, res) => res.status(403).json({
  success: false,
  message: 'La inscripción y circulación de facturas como título valor (eventos 036 a 046) no está disponible en Pitbox.',
});
router.post('/sales/:id/inscripcion',          faseNoDisponible, ctrl.emitInscripcion);
router.post('/sales/:id/endoso',               faseNoDisponible, ctrl.emitEndoso);
router.post('/sales/:id/cancelar-endoso',      faseNoDisponible, ctrl.emitCancelacionEndoso);
router.post('/sales/:id/limitacion',           faseNoDisponible, ctrl.emitLimitacion);
router.post('/sales/:id/terminar-limitacion',  faseNoDisponible, ctrl.emitTerminarLimitacion);
router.post('/sales/:id/mandato',              faseNoDisponible, ctrl.emitMandato);
router.post('/sales/:id/terminar-mandato',     faseNoDisponible, ctrl.emitTerminarMandato);
router.post('/sales/:id/pago',                 faseNoDisponible, ctrl.emitPago);
router.post('/sales/:id/informe-pago',         faseNoDisponible, ctrl.emitInformePago);

router.get('/pending', ctrl.getPending);

module.exports = router;
