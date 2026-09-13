const express = require('express');
const router = express.Router();
const payrollCertificatesController = require('../../controllers/payroll/payrollCertificates.controller');

// Autenticación/tenant/módulo aplicados en server.js — solo lectura,
// agrega PayrollDocument ya aceptados por la DIAN (ver
// payrollCertificateService.js). No crea ni modifica nada.
router.get('/', payrollCertificatesController.getAvailableCertificates);
router.get('/:employee_id', payrollCertificatesController.getCertificateSummary);
router.get('/:employee_id/pdf', payrollCertificatesController.downloadCertificatePdf);

module.exports = router;
