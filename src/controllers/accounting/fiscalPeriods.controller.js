// backend/src/controllers/accounting/fiscalPeriods.controller.js
const { closePeriod, reopenPeriod, listPeriods, closeFiscalYear } = require('../../services/accounting/fiscalPeriod.service');
const logger = require('../../config/logger');

// GET /api/accounting/fiscal-periods?year=
exports.list = async (req, res) => {
  try {
    const { year } = req.query;
    const periods = await listPeriods(req.tenant_id, { year: year ? Number(year) : undefined });
    res.json({ success: true, data: periods });
  } catch (error) {
    logger.error('Error en fiscalPeriods.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar períodos fiscales', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PATCH /api/accounting/fiscal-periods/:id/close
exports.close = async (req, res) => {
  try {
    const period = await closePeriod(req.params.id, req.tenant_id, req.user?.id);
    res.json({ success: true, data: period });
  } catch (error) {
    logger.error('Error en fiscalPeriods.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/fiscal-periods/:id/reopen
exports.reopen = async (req, res) => {
  try {
    const period = await reopenPeriod(req.params.id, req.tenant_id, req.user?.id, req.body?.reason);
    res.json({ success: true, data: period });
  } catch (error) {
    logger.error('Error en fiscalPeriods.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/accounting/fiscal-years/:year/close
// Cierre de ejercicio: cierra los meses del año que falten, genera el
// asiento que traslada el resultado del año a patrimonio, y cierra diciembre.
exports.closeYear = async (req, res) => {
  try {
    const year = Number(req.params.year);
    if (!year || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: 'Año inválido' });
    }
    const result = await closeFiscalYear(req.tenant_id, year, req.user?.id);
    res.json({
      success: true,
      message: result.entry ? `Ejercicio ${year} cerrado correctamente` : `Ejercicio ${year} cerrado (sin movimientos que contabilizar)`,
      data: result,
    });
  } catch (error) {
    logger.error('Error en fiscalPeriods.controller.js:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};
