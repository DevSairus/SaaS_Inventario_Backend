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

// Mapeo de eventos -> cuentas
router.get('/account-mappings', accountMappingsCtrl.list);
router.put('/account-mappings/:event_type', accountMappingsCtrl.upsert);

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

module.exports = router;
