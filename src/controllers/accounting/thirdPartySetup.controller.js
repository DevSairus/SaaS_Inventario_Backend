// backend/src/controllers/accounting/thirdPartySetup.controller.js
// 3.2 — Terceros nuevos pendientes de revisión contable.
//   GET  /api/accounting/third-parties/pending-setup
//   POST /api/accounting/third-parties/:kind/:id/configured   (kind: customer | supplier)
const service = require('../../services/accounting/thirdPartySetup.service');
const logger = require('../../config/logger');

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}:`, error);
  return res.status(500).json({ success: false, message });
};

exports.listPending = async (req, res) => {
  try {
    res.json({ success: true, data: await service.listPending(req.tenant_id) });
  } catch (error) {
    fail(res, error, 'Error al listar los terceros pendientes');
  }
};

exports.markConfigured = async (req, res) => {
  try {
    await service.markConfigured(req.tenant_id, req.params.kind, req.params.id, req.user?.id);
    res.json({ success: true, message: 'Marcado como configurado' });
  } catch (error) {
    fail(res, error, 'Error al marcar el tercero como configurado');
  }
};
