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

const { BankAccount, ChartOfAccount, JournalEntryLine, sequelize } = require('../../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');
const { BANK_ACCOUNT_TYPES, resolveTypeAndCurrency } = require('../../services/accounting/bankAccountTypes');

/**
 * 5.2 — Cuenta PUC "padre" del tipo de cuenta bancaria. En tenants que ya
 * tenían plan de cuentas puede faltar (112005 / 111010 / 1120): se crea al
 * vuelo, igual que el resto de pasos de reconciliación del PUC.
 */
async function ensureTypeParentAccount(tenantId, type, transaction) {
  const spec = BANK_ACCOUNT_TYPES[type];
  let parent = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: spec.parentCode }, transaction });
  if (parent) return parent;

  let group = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: spec.groupCode }, transaction });
  if (!group) {
    const cash = await ChartOfAccount.findOne({ where: { tenant_id: tenantId, code: '11' }, transaction });
    group = await ChartOfAccount.create(
      { tenant_id: tenantId, code: spec.groupCode, name: spec.groupName, account_type: 'activo', parent_id: cash?.id || null, level: 3, accepts_entries: false, is_active: true },
      { transaction }
    );
  }
  parent = await ChartOfAccount.create(
    { tenant_id: tenantId, code: spec.parentCode, name: spec.parentName, account_type: 'activo', parent_id: group.id, level: (group.level || 3) + 1, accepts_entries: true, is_active: true },
    { transaction }
  );
  return parent;
}

const subaccountName = (bankName, alias, number) => `Bancos - ${bankName}${alias ? ` (${alias})` : ` (${number})`}`;

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

// GET /api/bank-account-options -- montado fuera de /api/accounting: lo usa
// el selector de cuenta bancaria al cobrar/pagar (ventas, cartera, gastos),
// donde el usuario puede no tener rol contable. Solo cuentas activas y
// datos para mostrarlas, sin la subcuenta PUC.
exports.options = async (req, res) => {
  try {
    const accounts = await BankAccount.findAll({
      where: { tenant_id: req.tenant_id, is_active: true },
      attributes: ['id', 'bank_name', 'account_alias', 'account_number', 'account_type', 'currency'],
      order: [['bank_name', 'ASC']],
    });
    res.json({ success: true, data: accounts });
  } catch (error) {
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar cuentas bancarias' });
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
    const { type, currency } = resolveTypeAndCurrency(req.body.account_type, req.body.currency);

    if (!bank_name || !bank_name.trim()) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El nombre del banco es obligatorio' });
    }
    if (!account_number || !account_number.trim()) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'El número (o últimos dígitos) de la cuenta es obligatorio' });
    }

    // El tipo decide la cuenta padre: corriente 111005, ahorros 112005, moneda extranjera 111010.
    // Antes de crear la del tipo se exige el plan base (111005) para no sembrar
    // cuentas en un tenant sin plan de cuentas.
    const basePlan = await ChartOfAccount.findOne({ where: { tenant_id: req.tenant_id, code: '111005' }, transaction });
    const parentAccount = basePlan && type === 'corriente'
      ? basePlan
      : (basePlan ? await ensureTypeParentAccount(req.tenant_id, type, transaction) : null);
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
        name: subaccountName(bank_name, account_alias, account_number),
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
        account_type: type,
        currency,
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
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear la cuenta bancaria', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// PUT /bank-accounts/:id — alias / activo / NIT del banco, y (5.2) el tipo y la
// moneda. bank_name/account_number no se editan aquí a propósito: cambiarlos de
// fondo confundiría el histórico de movimientos ya importados bajo esta cuenta.
//
// Reclasificar (cambiar tipo o moneda) mueve la subcuenta a otra cuenta padre del
// PUC, así que solo se permite mientras la subcuenta no tenga movimientos
// contables: con movimientos, el saldo histórico quedaría bajo la clasificación vieja.
exports.update = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const account = await BankAccount.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id }, transaction });
    if (!account) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cuenta bancaria no encontrada' });
    }

    const { account_alias, is_active, bank_tax_id } = req.body;
    const typeChanging = req.body.account_type !== undefined || req.body.currency !== undefined;
    const target = typeChanging
      ? resolveTypeAndCurrency(req.body.account_type !== undefined ? req.body.account_type : account.account_type,
        req.body.currency !== undefined ? req.body.currency : account.currency)
      : { type: account.account_type, currency: account.currency };

    if (target.type !== account.account_type) {
      const movements = await JournalEntryLine.count({ where: { account_id: account.chart_of_account_id }, transaction });
      if (movements > 0) {
        await transaction.rollback();
        return res.status(409).json({
          success: false,
          message: `La cuenta ya tiene ${movements} movimiento(s) contable(s): no se puede cambiar su tipo sin partir su historial. Cree una cuenta nueva del tipo correcto y desactive esta.`,
        });
      }
      const parent = await ensureTypeParentAccount(req.tenant_id, target.type, transaction);
      const childCode = await nextChildCode(req.tenant_id, parent.code, transaction);
      const sub = await ChartOfAccount.findOne({ where: { id: account.chart_of_account_id, tenant_id: req.tenant_id }, transaction });
      if (sub) {
        await sub.update({ code: childCode, parent_id: parent.id, level: parent.level + 1 }, { transaction });
      }
    }

    await account.update({
      account_alias: account_alias !== undefined ? account_alias : account.account_alias,
      is_active: is_active !== undefined ? is_active : account.is_active,
      bank_tax_id: bank_tax_id !== undefined ? (bank_tax_id?.trim() || null) : account.bank_tax_id,
      account_type: target.type,
      currency: target.currency,
    }, { transaction });

    await transaction.commit();
    res.json({ success: true, data: account });
  } catch (error) {
    await transaction.rollback();
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    logger.error('Error en bankAccounts.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar la cuenta bancaria', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
