const express = require('express');
const router = express.Router();

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

// Plan de cuentas
router.get('/chart-of-accounts', chartOfAccountsCtrl.list);
router.post('/chart-of-accounts', chartOfAccountsCtrl.create);
router.put('/chart-of-accounts/:id', chartOfAccountsCtrl.update);
router.delete('/chart-of-accounts/:id', chartOfAccountsCtrl.remove);

// Asientos contables
router.get('/journal-entries', journalEntriesCtrl.list);
router.get('/journal-entries/:id', journalEntriesCtrl.getById);
router.post('/journal-entries', journalEntriesCtrl.create);
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

module.exports = router;
