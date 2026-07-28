// backend/src/routes/sales/workshopDiagnosis.routes.js
//
// Vive bajo /api/sales, pero solo tiene sentido con el módulo Taller activo
// (se monta con requireModule('workshop') en server.js, sin afectar el
// resto de /api/sales que no depende de ese módulo).
const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/sales/saleDiagnosisMarks.controller');

// Mapa de intervención sobre una cotización
router.get('/:id/diagnosis-marks', ctrl.listDiagnosisMarks);
router.post('/:id/diagnosis-marks', ctrl.addDiagnosisMark);
router.put('/:id/diagnosis-marks/:markId', ctrl.updateDiagnosisMark);
router.delete('/:id/diagnosis-marks/:markId', ctrl.removeDiagnosisMark);
router.post('/:id/diagnosis-marks/generate-items', ctrl.generateItemsFromMarks);

// Cotización → Orden de Trabajo
router.post('/:id/convert-to-work-order', ctrl.convertToWorkOrder);

module.exports = router;
