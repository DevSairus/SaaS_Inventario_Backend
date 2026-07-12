const { ChartOfAccount, JournalEntryLine } = require('../../models');
const logger = require('../../config/logger');

// GET /api/accounting/chart-of-accounts
exports.list = async (req, res) => {
  try {
    const accounts = await ChartOfAccount.findAll({
      where: { tenant_id: req.tenant_id },
      order: [['code', 'ASC']],
    });
    res.json({ success: true, data: accounts });
  } catch (error) {
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar plan de cuentas', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /api/accounting/chart-of-accounts
exports.create = async (req, res) => {
  try {
    const { code, name, account_type, parent_id, accepts_entries } = req.body;
    if (!code || !name || !account_type) {
      return res.status(400).json({ success: false, message: 'code, name y account_type son obligatorios' });
    }

    let level = 1;
    if (parent_id) {
      const parent = await ChartOfAccount.findOne({ where: { id: parent_id, tenant_id: req.tenant_id } });
      if (!parent) return res.status(404).json({ success: false, message: 'Cuenta padre no encontrada' });
      level = parent.level + 1;
    }

    const account = await ChartOfAccount.create({
      tenant_id: req.tenant_id,
      code,
      name,
      account_type,
      parent_id: parent_id || null,
      level,
      accepts_entries: accepts_entries !== undefined ? accepts_entries : true,
    });

    res.status(201).json({ success: true, data: account });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Ya existe una cuenta con ese código' });
    }
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear cuenta', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /api/accounting/chart-of-accounts/:id
exports.update = async (req, res) => {
  try {
    const account = await ChartOfAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });

    const { name, is_active, accepts_entries } = req.body;
    await account.update({
      name: name ?? account.name,
      is_active: is_active !== undefined ? is_active : account.is_active,
      accepts_entries: accepts_entries !== undefined ? accepts_entries : account.accepts_entries,
    });

    res.json({ success: true, data: account });
  } catch (error) {
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar cuenta', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// DELETE /api/accounting/chart-of-accounts/:id
exports.remove = async (req, res) => {
  try {
    const account = await ChartOfAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });

    const hasMovements = await JournalEntryLine.count({ where: { account_id: account.id } });
    if (hasMovements > 0) {
      return res.status(409).json({ success: false, message: 'No se puede eliminar: la cuenta ya tiene movimientos contables. Desactívala en su lugar.' });
    }

    const hasChildren = await ChartOfAccount.count({ where: { parent_id: account.id } });
    if (hasChildren > 0) {
      return res.status(409).json({ success: false, message: 'No se puede eliminar: tiene subcuentas asociadas' });
    }

    await account.destroy();
    res.json({ success: true, message: 'Cuenta eliminada' });
  } catch (error) {
    logger.error('Error en chartOfAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar cuenta', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
