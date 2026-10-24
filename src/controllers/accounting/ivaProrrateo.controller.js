// backend/src/controllers/accounting/ivaProrrateo.controller.js
//
// Prorrateo del IVA descontable por período (art. 490 E.T.). Ver
// services/tax/ivaProrrateo.service.js.
const { computeIvaProrrateo, createProrrateoEntry } = require('../../services/tax/ivaProrrateo.service');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}:`, error);
  return res.status(400).json({ success: false, message: error.message || message });
};

// GET /api/accounting/iva-prorrateo?year=&period=
exports.report = async (req, res) => {
  try {
    const data = await computeIvaProrrateo(req.tenant_id, { year: req.query.year, period: req.query.period });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error calculando el prorrateo de IVA');
  }
};

// POST /api/accounting/iva-prorrateo { year, period, amount? } → asiento en borrador
exports.createEntry = async (req, res) => {
  try {
    const { year, period, amount } = req.body || {};
    const data = await createProrrateoEntry(req.tenant_id, { year, period, amount }, req.user.id);
    res.status(201).json({ success: true, data, message: `Ajuste ${data.entry.entry_number} creado en borrador` });
  } catch (error) {
    fail(res, error, 'Error creando el ajuste de prorrateo de IVA');
  }
};
