const express = require('express');
const router = express.Router();
const multer = require('multer');

const chartOfAccountsCtrl = require('../../controllers/accounting/chartOfAccounts.controller');
const journalEntriesCtrl = require('../../controllers/accounting/journalEntries.controller');
const accountMappingsCtrl = require('../../controllers/accounting/accountMappings.controller');
const reportsCtrl = require('../../controllers/accounting/financialReports.controller');
const libroDiarioCtrl = require('../../controllers/accounting/libroDiario.controller');
const libroMayorCtrl = require('../../controllers/accounting/libroMayor.controller');
const libroAuxiliarCtrl = require('../../controllers/accounting/libroAuxiliar.controller');
const libroIvaCtrl = require('../../controllers/accounting/libroIva.controller');
const fiscalPeriodsCtrl = require('../../controllers/accounting/fiscalPeriods.controller');
const accountingHealthCtrl = require('../../controllers/accounting/accountingHealth.controller');
const agingReportCtrl = require('../../controllers/accounting/agingReport.controller');
const withholdingReportCtrl = require('../../controllers/accounting/withholdingReport.controller');
const cashFlowIndirectCtrl = require('../../controllers/accounting/cashFlowIndirect.controller');
const openingBalancesCtrl = require('../../controllers/accounting/openingBalances.controller');
const fixedAssetsCtrl = require('../../controllers/accounting/fixedAssets.controller');
const loansCtrl = require('../../controllers/accounting/loans.controller');
const bankAccountsCtrl = require('../../controllers/accounting/bankAccounts.controller');
const bankImportCtrl = require('../../controllers/accounting/bankImport.controller');
const bankReconciliationCtrl = require('../../controllers/accounting/bankReconciliation.controller');
const exogenaCtrl = require('../../controllers/accounting/exogena.controller');

// Extracto bancario: mismo límite/patrón de multer que invoiceImport.routes.js.
const uploadStatement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Plan de cuentas
router.get('/chart-of-accounts', chartOfAccountsCtrl.list);
router.post('/chart-of-accounts', chartOfAccountsCtrl.create);
router.put('/chart-of-accounts/:id', chartOfAccountsCtrl.update);
router.delete('/chart-of-accounts/:id', chartOfAccountsCtrl.remove);

// Asientos contables
router.get('/journal-entries', journalEntriesCtrl.list);
router.get('/journal-entries/:id', journalEntriesCtrl.getById);
router.post('/journal-entries', journalEntriesCtrl.create);
router.put('/journal-entries/:id', journalEntriesCtrl.update);
router.patch('/journal-entries/:id/post', journalEntriesCtrl.post);
router.patch('/journal-entries/:id/void', journalEntriesCtrl.void);
router.patch('/journal-entries/:id/reverse', journalEntriesCtrl.reverse);

// Mapeo de eventos -> cuentas
router.get('/account-mappings', accountMappingsCtrl.list);
router.post('/account-mappings', accountMappingsCtrl.create);
router.put('/account-mappings/:event_type', accountMappingsCtrl.upsert);
router.delete('/account-mappings/:event_type', accountMappingsCtrl.remove);
router.get('/account-mappings/:event_type/audit', accountMappingsCtrl.auditHistory);

// Períodos fiscales (cierre/reapertura)
router.get('/fiscal-periods', fiscalPeriodsCtrl.list);
router.patch('/fiscal-periods/:id/close', fiscalPeriodsCtrl.close);
router.patch('/fiscal-periods/:id/reopen', fiscalPeriodsCtrl.reopen);

// Cierre de ejercicio (año completo, traslada resultado a patrimonio)
router.patch('/fiscal-years/:year/close', fiscalPeriodsCtrl.closeYear);

// Reportes financieros
router.get('/reports/trial-balance', reportsCtrl.trialBalance);
router.get('/reports/balance-general', reportsCtrl.balanceGeneral);
router.get('/reports/income-statement', reportsCtrl.incomeStatement);

// Exportación Excel / PDF de los reportes financieros (Fase 1 del plan de informes contables)
router.get('/reports/trial-balance/export', reportsCtrl.trialBalanceExport);
router.get('/reports/balance-general/export', reportsCtrl.balanceGeneralExport);
router.get('/reports/income-statement/export', reportsCtrl.incomeStatementExport);

// Libro Diario (Fase 2 del plan de informes contables)
router.get('/reports/libro-diario', libroDiarioCtrl.libroDiario);
router.get('/reports/libro-diario/export', libroDiarioCtrl.libroDiarioExport);

// Libro Mayor por cuenta (Fase 3 del plan de informes contables)
router.get('/reports/libro-mayor/:account_id', libroMayorCtrl.libroMayor);
router.get('/reports/libro-mayor/:account_id/export', libroMayorCtrl.libroMayorExport);

// Libro Auxiliar por tercero + Libro de IVA (Fase 4 del plan de informes contables)
router.get('/reports/libro-auxiliar', libroAuxiliarCtrl.libroAuxiliar);
router.get('/reports/libro-auxiliar/export', libroAuxiliarCtrl.libroAuxiliarExport);
router.get('/reports/libro-iva', libroIvaCtrl.libroIva);
router.get('/reports/libro-iva/export', libroIvaCtrl.libroIvaExport);

// ── Fase 5 del plan de informes contables (sección 4.2 del análisis) ──

// Salud Contable: expone journalIntegrity.service.js (huecos, borradores
// pendientes, consistencia) que antes solo consultaba el asistente de IA.
router.get('/health', accountingHealthCtrl.summary);
router.post('/health/missing-entries/generate-all', accountingHealthCtrl.generateAllMissingEntries);
router.post('/health/missing-entries/:source_type/:source_id/generate', accountingHealthCtrl.generateMissingEntry);

// Antigüedad de cartera (clientes) y cuentas por pagar (proveedores).
router.get('/reports/aging', agingReportCtrl.aging);
router.get('/reports/aging/export', agingReportCtrl.agingExport);

// Balance de comprobación comparativo (período actual vs. anterior).
router.get('/reports/trial-balance-comparativo', reportsCtrl.trialBalanceComparative);
router.get('/reports/trial-balance-comparativo/export', reportsCtrl.trialBalanceComparativeExport);

// Certificado / reporte de retenciones (ReteFuente, ReteICA) practicadas por clientes.
router.get('/reports/retenciones', withholdingReportCtrl.withholding);
router.get('/reports/retenciones/export', withholdingReportCtrl.withholdingExport);

// Estado de Flujo de Efectivo — método indirecto, derivado de los asientos.
router.get('/reports/cashflow-indirecto', cashFlowIndirectCtrl.cashFlowIndirect);
router.get('/reports/cashflow-indirecto/export', cashFlowIndirectCtrl.cashFlowIndirectExport);

// Saldos iniciales (cartera/CxP/cuentas/inventario al arrancar con Pitbox)
router.get('/opening-balances', openingBalancesCtrl.list);
router.post('/opening-balances/receivable', openingBalancesCtrl.createReceivable);
router.post('/opening-balances/payable', openingBalancesCtrl.createPayable);
router.post('/opening-balances/account', openingBalancesCtrl.createAccount);
router.post('/opening-balances/inventory', openingBalancesCtrl.createInventory);
router.get('/opening-balances/bridge-status', openingBalancesCtrl.getBridgeStatus);
router.post('/opening-balances/bridge-status/close', openingBalancesCtrl.closeBridge);
router.post('/opening-balances/:id/void', openingBalancesCtrl.voidOpeningBalance);
router.post('/opening-balances/:id/payments', openingBalancesCtrl.registerPayment);

// Activos Fijos y Depreciación (Fase 1 del plan de Contabilidad Pitbox).
// '/report' y '/run-depreciation' van ANTES de '/:id' para que Express no
// los capture como si "report"/"run-depreciation" fueran un :id.
router.get('/fixed-assets/report', fixedAssetsCtrl.report);
router.post('/fixed-assets/run-depreciation', fixedAssetsCtrl.runDepreciation);
router.get('/fixed-assets', fixedAssetsCtrl.list);
router.get('/fixed-assets/:id', fixedAssetsCtrl.getById);
router.post('/fixed-assets', fixedAssetsCtrl.create);
router.put('/fixed-assets/:id', fixedAssetsCtrl.update);
router.post('/fixed-assets/:id/dispose', fixedAssetsCtrl.dispose);

// Créditos y Amortización (Fase 2 del plan de Contabilidad Pitbox).
// '/report' va ANTES de '/:id' por la misma razón que en fixed-assets.
router.get('/loans/report', loansCtrl.report);
router.get('/loans', loansCtrl.list);
router.get('/loans/:id', loansCtrl.getById);
router.post('/loans', loansCtrl.create);
router.post('/loans/:id/installments/:installmentId/pay', loansCtrl.payInstallment);

// Conciliación Bancaria (Fase 3 del plan de Contabilidad Pitbox).
// Rutas de importación/conciliación anidadas bajo '/bank-accounts/:id/...'
// van ANTES de '/:id' con PUT, por la misma razón que en fixed-assets/loans.
router.get('/bank-accounts', bankAccountsCtrl.list);
router.post('/bank-accounts', bankAccountsCtrl.create);
router.get('/bank-accounts/:id', bankAccountsCtrl.getById);
router.put('/bank-accounts/:id', bankAccountsCtrl.update);

router.post('/bank-accounts/:id/import/preview', uploadStatement.single('file'), bankImportCtrl.preview);
router.post('/bank-accounts/:id/import', uploadStatement.single('file'), bankImportCtrl.runImport);

router.get('/bank-accounts/:id/reconciliation', bankReconciliationCtrl.view);
router.post('/bank-accounts/:id/reconciliation/run-auto-match', bankReconciliationCtrl.runAutoMatch);
router.post('/bank-accounts/:id/reconciliation/:txId/match', bankReconciliationCtrl.matchManually);
router.post('/bank-accounts/:id/reconciliation/:txId/unmatch', bankReconciliationCtrl.unmatch);
router.post('/bank-accounts/:id/reconciliation/:txId/ignore', bankReconciliationCtrl.ignore);

// Información Exógena DIAN (Fase 4 del plan de Contabilidad Pitbox).
// '/manual-records' va ANTES de '/formats/:code' por la misma razón que en
// fixed-assets/loans/bank-accounts.
router.get('/exogena/manual-records', exogenaCtrl.listManualRecords);
router.post('/exogena/manual-records', exogenaCtrl.createManualRecord);
router.put('/exogena/manual-records/:id', exogenaCtrl.updateManualRecord);
router.delete('/exogena/manual-records/:id', exogenaCtrl.deleteManualRecord);

router.get('/exogena/shareholders', exogenaCtrl.listShareholders);
router.post('/exogena/shareholders', exogenaCtrl.createShareholder);
router.put('/exogena/shareholders/:id', exogenaCtrl.updateShareholder);
router.delete('/exogena/shareholders/:id', exogenaCtrl.deleteShareholder);

router.get('/exogena/formats', exogenaCtrl.list);
router.put('/exogena/formats/:code', exogenaCtrl.toggle);
router.get('/exogena/formats/:code/concepts', exogenaCtrl.getConcepts);
router.put('/exogena/formats/:code/concepts', exogenaCtrl.saveConcepts);
router.get('/exogena/formats/:code/readiness', exogenaCtrl.readiness);
router.get('/exogena/formats/:code/generate', exogenaCtrl.generateFile);

module.exports = router;
