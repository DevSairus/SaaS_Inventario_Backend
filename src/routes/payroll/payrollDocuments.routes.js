const express = require('express');
const router = express.Router();
const payrollDocumentsController = require('../../controllers/payroll/payrollDocuments.controller');

// Autenticación/tenant/módulo aplicados en server.js — solo lectura, la
// emisión vive en payrollPeriods.controller.js#changePayrollPeriodStatus.
router.get('/', payrollDocumentsController.getPayrollDocuments);
router.get('/:id', payrollDocumentsController.getPayrollDocumentById);
router.get('/:id/xml', payrollDocumentsController.downloadPayrollDocumentXml);
router.get('/:id/pdf', payrollDocumentsController.downloadPayrollDocumentPdf);
router.post('/:id/adjustments', payrollDocumentsController.createPayrollDocumentAdjustment);

module.exports = router;
