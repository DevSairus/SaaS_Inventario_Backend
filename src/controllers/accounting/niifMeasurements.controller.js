// backend/src/controllers/accounting/niifMeasurements.controller.js
//
// Mediciones NIIF de cierre: deterioro de cartera, valor neto realizable y
// diferencia en cambio. Ver services/accounting/niifMeasurements.service.js.

const svc = require('../../services/accounting/niifMeasurements.service');
const logger = require('../../config/logger');

function fail(res, error, message) {
  if (!error.statusCode) logger.error(`[NIIF mediciones] ${message}:`, error);
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.statusCode ? error.message : message,
    error: process.env.NODE_ENV === 'production' ? undefined : error.message,
  });
}

// POST /api/accounting/niif-measurements/:kind/preview  { cutoff_date, params }
exports.preview = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.preview(req.tenant_id, req.params.kind, req.body || {}) });
  } catch (error) {
    fail(res, error, 'Error al calcular la medición');
  }
};

// POST /api/accounting/niif-measurements/:kind/apply  { cutoff_date, params }
exports.apply = async (req, res) => {
  try {
    const data = await svc.apply(req.tenant_id, req.params.kind, req.body || {}, req.user?.id);
    res.status(201).json({ success: true, data, message: `Ajuste contabilizado (${data.entry_number})` });
  } catch (error) {
    fail(res, error, 'Error al contabilizar la medición');
  }
};

// GET /api/accounting/niif-measurements?kind=
exports.history = async (req, res) => {
  try {
    res.json({ success: true, data: await svc.history(req.tenant_id, req.query.kind || null) });
  } catch (error) {
    fail(res, error, 'Error al listar las mediciones');
  }
};

// POST /api/accounting/niif-measurements/:id/reverse  { reason }
exports.reverse = async (req, res) => {
  try {
    await svc.reverse(req.tenant_id, req.params.id, req.user?.id, req.body?.reason);
    res.json({ success: true, message: 'Medición reversada' });
  } catch (error) {
    fail(res, error, 'Error al reversar la medición');
  }
};

// GET /api/accounting/niif-measurements/trm?date=
exports.trm = async (req, res) => {
  try {
    const trm = await svc.officialTrm(req.query.date);
    if (!trm) return res.json({ success: false, message: 'No se pudo consultar la TRM oficial: escríbela a mano.' });
    res.json({ success: true, data: trm });
  } catch (error) {
    fail(res, error, 'Error al consultar la TRM');
  }
};
