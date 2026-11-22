// backend/src/controllers/accounting/fiscalReconciliation.controller.js
//
// Conciliación fiscal (soporte del formato 2516). Ver
// services/accounting/fiscalReconciliation.service.js.

const svc = require('../../services/accounting/fiscalReconciliation.service');
const { generateFiscalReconciliationExcel } = require('../../services/accounting/niifExcel.service');
const logger = require('../../config/logger');

function fail(res, error, message) {
  if (!error.statusCode) logger.error(`[Conciliación fiscal] ${message}:`, error);
  if (res.headersSent) return;
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : message,
    error: process.env.NODE_ENV === 'production' ? undefined : error.message,
  });
}

const yearOf = (req) => {
  const y = Number(req.params.year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    const err = new Error('Año inválido');
    err.statusCode = 400;
    throw err;
  }
  return y;
};
const handler = (fn, message) => async (req, res) => {
  try {
    const data = await fn(req);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, message);
  }
};

// GET /fiscal-reconciliation/:year/esf
exports.esf = handler((req) => svc.esfReconciliation(req.tenant_id, `${yearOf(req)}-12-31`), 'Error al generar la conciliación patrimonial');
// GET /fiscal-reconciliation/:year/eri
exports.eri = handler((req) => svc.eriReconciliation(req.tenant_id, yearOf(req)), 'Error al generar la conciliación de renta líquida');
// GET /fiscal-reconciliation/:year/settings
exports.getSettings = handler((req) => svc.getSettings(req.tenant_id, yearOf(req)), 'Error al leer los parámetros');
// PUT /fiscal-reconciliation/:year/settings
exports.saveSettings = handler((req) => svc.saveSettings(req.tenant_id, yearOf(req), req.body || {}, req.user?.id), 'Error al guardar los parámetros');
// GET /fiscal-reconciliation/:year/adjustments
exports.listAdjustments = handler((req) => svc.listAdjustments(req.tenant_id, yearOf(req)), 'Error al listar los ajustes');
// POST /fiscal-reconciliation/:year/adjustments
exports.createAdjustment = handler((req) => svc.createAdjustment(req.tenant_id, { ...req.body, year: yearOf(req) }, req.user?.id), 'Error al crear el ajuste');
// DELETE /fiscal-reconciliation/adjustments/:id
exports.deleteAdjustment = handler((req) => svc.deleteAdjustment(req.tenant_id, req.params.id), 'Error al eliminar el ajuste');
// POST /fiscal-reconciliation/:year/adjustments/copy-previous
exports.copyPrevious = handler((req) => svc.copyAdjustmentsFromPreviousYear(req.tenant_id, yearOf(req), req.user?.id), 'Error al copiar los ajustes');

// GET /fiscal-reconciliation/:year/export
exports.export = async (req, res) => {
  try {
    const year = yearOf(req);
    const [esf, eri] = await Promise.all([
      svc.esfReconciliation(req.tenant_id, `${year}-12-31`),
      svc.eriReconciliation(req.tenant_id, year),
    ]);
    const name = [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ') || req.user?.email || '';
    const buffer = await generateFiscalReconciliationExcel({ esf, eri }, req.tenant, name);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Conciliacion-Fiscal-${year}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    fail(res, error, 'Error al exportar la conciliación fiscal');
  }
};
