// backend/src/controllers/accounting/bankAccounts.controller.js
//
// Cuentas bancarias del tenant — Fase 3 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3.
//
// Endpoints:
//   GET  /api/accounting/bank-accounts        → list
//   GET  /api/accounting/bank-accounts/:id    → getById
//   POST /api/accounting/bank-accounts        → create (crea la subcuenta PUC automáticamente)
//   PUT  /api/accounting/bank-accounts/:id    → update (alias / activo)

const { BankAccount, ChartOfAccount, sequelize } = require('../../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

// GET /bank-accounts
exports.list = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.is_active !== undefined) where.is_active = req.query.is_active === 'true';

    const accounts = await BankAccount.findAll({
      where,
      include: [{ model: ChartOfAccount, as: 'chart_of_account', attributes: ['id', 'code', 'name'] }],
      order: [['bank_name', 'ASC']],
    });
    res.json({ success: true, data: accounts });
  } catch (error) {
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar cuentas bancarias', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /bank-accounts/:id
exports.getById = async (req, res) => {
  try {
    const account = await BankAccount.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
      include: [{ model: ChartOfAccount, as: 'chart_of_account', attributes: ['id', 'code', 'name'] }],
    });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta bancaria no encontrada' });
    res.json({ success: true, data: account });
  } catch (error) {
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la cuenta bancaria', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

/**
 * Siguiente código libre para una subcuenta hija de `parentCode`
 * (ej. 111005-01, 111005-02...) para este tenant.
 */
async function nextChildCode(tenantId, parentCode, transaction) {
  const existing = await ChartOfAccount.findAll({
    where: { tenant_id: tenantId, code: { [Op.like]: `${parentCode}-%` } },
    attributes: ['code'],
    transaction,
  });
  const usedNumbers = existing
    .map((a) => parseInt(a.code.split('-').pop(), 10))
    .filter((n) => !isNaN(n));
  const next = usedNumbers.length ? Math.max(...usedNumbers) + 1 : 1;
  return `${parentCode}-${String(next).padStart(2, '0')}`;
}

// POST /bank-accounts
// Crea la fila + su subcuenta PUC dedicada (hija de 111005 "Bancos - Moneda
// Nacional"), como dice el plan: "se crea automáticamente al dar de alta la
// cuenta bancaria, como subcuenta hija de 111005".
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { bank_name, account_number, account_alias, bank_tax_id } = req.body;

    if (!bank_name || !bank_name.trim()) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El nombre del banco es obligatorio' });
    }
    if (!account_number || !account_number.trim()) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El número (o últimos dígitos) de la cuenta es obligatorio' });
    }

    const parentAccount = await ChartOfAccount.findOne({
      where: { tenant_id: req.tenant_id, code: '111005' },
      transaction,
    });
    if (!parentAccount) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        message: 'No existe la cuenta 111005 (Bancos) en el plan de cuentas de este tenant. Crea o restaura el plan de cuentas antes de agregar una cuenta bancaria.',
      });
    }

    const childCode = await nextChildCode(req.tenant_id, parentAccount.code, transaction);
    const chartAccount = await ChartOfAccount.create(
      {
        tenant_id: req.tenant_id,
        code: childCode,
        name: `Bancos - ${bank_name}${account_alias ? ` (${account_alias})` : ` (${account_number})`}`,
        account_type: 'activo',
        parent_id: parentAccount.id,
        level: parentAccount.level + 1,
        accepts_entries: true,
      },
      { transaction }
    );

    const bankAccount = await BankAccount.create(
      {
        tenant_id: req.tenant_id,
        bank_name: bank_name.trim(),
        account_number: account_number.trim(),
        account_alias: account_alias?.trim() || null,
        bank_tax_id: bank_tax_id?.trim() || null,
        chart_of_account_id: chartAccount.id,
        created_by: req.user_id || req.user?.id || null,
      },
      { transaction }
    );

    await transaction.commit();

    const data = await BankAccount.findOne({
      where: { id: bankAccount.id },
      include: [{ model: ChartOfAccount, as: 'chart_of_account', attributes: ['id', 'code', 'name'] }],
    });
    res.status(201).json({ success: true, data, message: `Cuenta bancaria creada con subcuenta PUC ${childCode}` });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear la cuenta bancaria', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /bank-accounts/:id — solo alias / activo. bank_name/account_number no
// se editan aquí a propósito: cambiarlos de fondo confundiría el histórico
// de movimientos ya importados bajo esta cuenta.
exports.update = async (req, res) => {
  try {
    const account = await BankAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!account) return res.status(404).json({ success: false, message: 'Cuenta bancaria no encontrada' });

    const { account_alias, is_active, bank_tax_id } = req.body;
    await account.update({
      account_alias: account_alias !== undefined ? account_alias : account.account_alias,
      is_active: is_active !== undefined ? is_active : account.is_active,
      bank_tax_id: bank_tax_id !== undefined ? (bank_tax_id?.trim() || null) : account.bank_tax_id,
    });

    res.json({ success: true, data: account });
  } catch (error) {
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la cuenta bancaria', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
