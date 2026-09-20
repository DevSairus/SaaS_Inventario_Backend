// backend/src/controllers/accounting/bankReconciliation.controller.js
//
// Conciliación Bancaria — Fase 3 del plan de Contabilidad Pitbox. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3, punto 7 (UI de
// conciliación).
//
// Endpoints:
//   GET  /api/accounting/bank-accounts/:id/reconciliation                → view
//   POST /api/accounting/bank-accounts/:id/reconciliation/run-auto-match → runAutoMatch
//   POST /api/accounting/bank-accounts/:id/reconciliation/:txId/match    → matchManually
//   POST /api/accounting/bank-accounts/:id/reconciliation/:txId/unmatch  → unmatch
//   POST /api/accounting/bank-accounts/:id/reconciliation/:txId/ignore   → ignore

const service = require('../../services/accounting/bankReconciliation.service');
const logger = require('../../config/logger');

// GET /bank-accounts/:id/reconciliation
exports.view = async (req, res) => {
  try {
    const { status, from_date, to_date } = req.query;
    const data = await service.getReconciliationView(req.tenant_id, req.params.id, { status, from_date, to_date });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error en bankReconciliation.controller.js (view):', error);
    const status = error.message === 'Cuenta bancaria no encontrada' ? 404 : 500;
    res.status(status).json({ success: false, message: error.message || 'Error al obtener la conciliación', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /bank-accounts/:id/reconciliation/run-auto-match
// Se corre automáticamente después de cada import, pero también se expone
// para reintentar cuando el usuario acaba de postear los asientos que
// faltaban (el matching automático solo ve asientos 'posted').
exports.runAutoMatch = async (req, res) => {
  try {
    const toleranceDays = req.body?.tolerance_days ? parseInt(req.body.tolerance_days, 10) : undefined;
    const summary = await service.runAutoMatch(req.tenant_id, req.params.id, toleranceDays ? { toleranceDays } : {});
    res.json({ success: true, data: summary, message: `${summary.matched} movimiento(s) conciliado(s) automáticamente.` });
  } catch (error) {
    logger.error('Error en bankReconciliation.controller.js (runAutoMatch):', error);
    const status = error.message === 'Cuenta bancaria no encontrada' ? 404 : 500;
    res.status(status).json({ success: false, message: error.message || 'Error al correr el matching automático', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /bank-accounts/:id/reconciliation/:txId/match
exports.matchManually = async (req, res) => {
  try {
    const { journal_entry_line_id } = req.body;
    if (!journal_entry_line_id) return res.status(400).json({ success: false, message: 'Debes indicar journal_entry_line_id' });

    const tx = await service.matchManually(req.tenant_id, req.params.txId, journal_entry_line_id);
    res.json({ success: true, data: tx, message: 'Movimiento conciliado.' });
  } catch (error) {
    logger.error('Error en bankReconciliation.controller.js (matchManually):', error);
    res.status(409).json({ success: false, message: error.message || 'Error al conciliar manualmente' });
  }
};

// POST /bank-accounts/:id/reconciliation/:txId/unmatch
exports.unmatch = async (req, res) => {
  try {
    const tx = await service.unmatch(req.tenant_id, req.params.txId);
    res.json({ success: true, data: tx, message: 'Conciliación deshecha.' });
  } catch (error) {
    logger.error('Error en bankReconciliation.controller.js (unmatch):', error);
    res.status(409).json({ success: false, message: error.message || 'Error al deshacer la conciliación' });
  }
};

// POST /bank-accounts/:id/reconciliation/:txId/ignore
exports.ignore = async (req, res) => {
  try {
    const tx = await service.markIgnored(req.tenant_id, req.params.txId);
    res.json({ success: true, data: tx, message: 'Movimiento marcado como ignorado.' });
  } catch (error) {
    logger.error('Error en bankReconciliation.controller.js (ignore):', error);
    res.status(409).json({ success: false, message: error.message || 'Error al ignorar el movimiento' });
  }
};
