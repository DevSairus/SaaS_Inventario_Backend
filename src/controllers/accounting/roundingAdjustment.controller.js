// backend/src/controllers/accounting/roundingAdjustment.controller.js
//
// 5.1 — Ajuste al peso: configuración (tope y activación) y bitácora.
//   GET /api/accounting/rounding-adjustment/config
//   PUT /api/accounting/rounding-adjustment/config   { enabled?, max_amount?, tolerance? }
//   GET /api/accounting/rounding-adjustments?date_from=&date_to=&limit=&offset=
const service = require('../../services/accounting/roundingAdjustment.service');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}:`, error);
  return res.status(500).json({ success: false, message });
};

exports.getConfig = async (req, res) => {
  try {
    const data = await service.getConfig(req.tenant_id);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error al leer la configuración del ajuste al peso');
  }
};

exports.updateConfig = async (req, res) => {
  try {
    const { enabled, max_amount: maxAmount, tolerance } = req.body || {};
    const input = {};
    if (enabled !== undefined) input.enabled = enabled;
    if (maxAmount !== undefined) input.max_amount = maxAmount;
    if (tolerance !== undefined) input.tolerance = tolerance;
    const data = await service.saveConfig(req.tenant_id, input);
    res.json({ success: true, data, message: 'Configuración guardada' });
  } catch (error) {
    fail(res, error, 'Error al guardar la configuración del ajuste al peso');
  }
};

exports.list = async (req, res) => {
  try {
    const data = await service.listAdjustments(req.tenant_id, {
      dateFrom: req.query.date_from, dateTo: req.query.date_to, limit: req.query.limit, offset: req.query.offset,
    });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error al listar los ajustes al peso');
  }
};
