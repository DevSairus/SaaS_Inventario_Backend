// backend/src/controllers/accounting/accountMigrations.controller.js
//
// Migración de movimientos entre cuentas -- solo contabilidad (checkRole en
// la ruta). Ver services/accounting/accountMigration.service.js.
const { AccountMigration, ChartOfAccount, User } = require('../../models');
const { previewMigration, executeMigration } = require('../../services/accounting/accountMigration.service');
const audit = require('../../utils/audit');
const logger = require('../../config/logger');

const paramsFrom = (src) => ({
  mode: src.mode,
  fromAccountId: src.from_account_id,
  toAccountId: src.to_account_id,
  dateFrom: src.date_from,
  dateTo: src.date_to,
  thirdPartyId: src.third_party_id || null,
  branchId: src.branch_id || null,
  entryDate: src.entry_date || null,
  reason: src.reason,
  updateMappings: !!src.update_mappings,
});

const fail = (res, error, message) => {
  if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
  logger.error(`${message}:`, error);
  // Errores de negocio de createDraftEntry (período cerrado, descuadre).
  return res.status(400).json({ success: false, message: error.message || message });
};

// POST /api/accounting/account-migrations/preview
exports.preview = async (req, res) => {
  try {
    const data = await previewMigration(req.tenant_id, paramsFrom(req.body));
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Error calculando la vista previa de la migración');
  }
};

// POST /api/accounting/account-migrations
exports.execute = async (req, res) => {
  try {
    const params = paramsFrom(req.body);
    const log = await executeMigration(req.tenant_id, params, req.user?.id);
    setImmediate(() => audit({
      tenant_id: req.tenant_id, user_id: req.user?.id, action: 'ACCOUNT_MIGRATION', entity: 'account_migration', entity_id: log.id,
      changes: { mode: log.mode, from_account_id: log.from_account_id, to_account_id: log.to_account_id, lines_count: log.lines_count, reason: log.reason },
      req,
    }));
    res.status(201).json({ success: true, message: log.mode === 'direct' ? `${log.lines_count} movimientos migrados` : 'Asiento de reclasificación contabilizado', data: log });
  } catch (error) {
    fail(res, error, 'Error ejecutando la migración');
  }
};

// GET /api/accounting/account-migrations
exports.list = async (req, res) => {
  try {
    const rows = await AccountMigration.findAll({
      where: { tenant_id: req.tenant_id },
      attributes: { exclude: ['line_ids'] },
      include: [
        { model: ChartOfAccount, as: 'from_account', attributes: ['id', 'code', 'name'] },
        { model: ChartOfAccount, as: 'to_account', attributes: ['id', 'code', 'name'] },
        { model: User, as: 'created_by_user', attributes: ['id', 'first_name', 'last_name'] },
      ],
      order: [['created_at', 'DESC']],
      limit: 100,
    });
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error('Error listando migraciones de cuentas:', error);
    res.status(500).json({ success: false, message: 'Error listando migraciones de cuentas' });
  }
};
