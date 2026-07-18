// backend/src/controllers/accounting/openingBalances.controller.js
//
// Carga de saldos iniciales (apertura contable): cartera por cobrar (CxC) y
// por pagar (CxP) por cliente/proveedor, cuentas generales (caja, bancos,
// activos fijos, patrimonio) e inventario existente con su costo. La lógica
// contable vive en services/accounting/openingBalance.service.js — este
// controller solo abre/cierra la transacción y traduce a HTTP.

const { sequelize } = require('../../config/database');
const { OpeningBalance, Customer, Supplier } = require('../../models');
const openingBalanceService = require('../../services/accounting/openingBalance.service');
const logger = require('../../config/logger');

// GET /api/accounting/opening-balances?type=receivable|payable
exports.list = async (req, res) => {
  try {
    const { type } = req.query;
    const where = { tenant_id: req.tenant_id };
    if (type) where.type = type;

    const rows = await OpeningBalance.findAll({
      where,
      include: [
        { model: Customer, as: 'customer', attributes: ['id', 'first_name', 'last_name'] },
        { model: Supplier, as: 'supplier', attributes: ['id', 'name'] },
      ],
      order: [['issue_date', 'DESC'], ['created_at', 'DESC']],
    });

    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error(`[openingBalances.list] ${error.message}`);
    res.status(500).json({ success: false, message: 'Error al listar saldos iniciales' });
  }
};

// POST /api/accounting/opening-balances/receivable
exports.createReceivable = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const openingBalance = await openingBalanceService.createReceivableOpeningBalance(
      req.tenant_id,
      { ...req.body, branch_id: req.body.branch_id || req.branch_id || null },
      req.user?.id,
      t
    );
    await t.commit();
    res.status(201).json({ success: true, data: openingBalance });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.createReceivable] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/accounting/opening-balances/payable
exports.createPayable = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const openingBalance = await openingBalanceService.createPayableOpeningBalance(
      req.tenant_id,
      { ...req.body, branch_id: req.body.branch_id || req.branch_id || null },
      req.user?.id,
      t
    );
    await t.commit();
    res.status(201).json({ success: true, data: openingBalance });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.createPayable] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/accounting/opening-balances/account
exports.createAccount = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const entry = await openingBalanceService.createAccountOpeningBalance(
      req.tenant_id,
      { ...req.body, branch_id: req.body.branch_id || req.branch_id || null },
      req.user?.id,
      t
    );
    await t.commit();
    res.status(201).json({ success: true, data: entry });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.createAccount] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/accounting/opening-balances/inventory
exports.createInventory = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const result = await openingBalanceService.createInventoryOpeningBalance(
      req.tenant_id,
      { ...req.body, branch_id: req.body.branch_id || req.branch_id || null },
      req.user?.id,
      t
    );
    await t.commit();
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.createInventory] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/accounting/opening-balances/bridge-status
exports.getBridgeStatus = async (req, res) => {
  try {
    const status = await openingBalanceService.getBridgeAccountStatus(req.tenant_id);
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error(`[openingBalances.getBridgeStatus] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/accounting/opening-balances/bridge-status/close
exports.closeBridge = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const entry = await openingBalanceService.closeBridgeAccount(req.tenant_id, req.body, req.user?.id, t);
    await t.commit();
    res.status(201).json({ success: true, data: entry });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.closeBridge] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/accounting/opening-balances/:id/void
exports.voidOpeningBalance = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const openingBalance = await openingBalanceService.voidOpeningBalance(
      req.params.id,
      req.tenant_id,
      req.user?.id,
      req.body?.reason,
      t
    );
    await t.commit();
    res.json({ success: true, data: openingBalance });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.voidOpeningBalance] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};

// POST /api/accounting/opening-balances/:id/payments
// Registra un abono contra un saldo inicial (cliente pagando una deuda
// vieja, o nosotros pagándole a un proveedor una deuda vieja). Mismo patrón
// que accountsPayable.controller.js registerPayment: SELECT FOR UPDATE +
// tope al saldo pendiente, más el asiento contable correspondiente
// reusando los mapeos ya existentes de caja/bancos.
exports.registerPayment = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { amount, payment_method, payment_date, notes } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'El monto debe ser mayor a 0' });
    }

    const openingBalance = await OpeningBalance.findOne({
      where: { id, tenant_id: req.tenant_id },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!openingBalance) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Saldo inicial no encontrado' });
    }
    if (openingBalance.status === 'voided') {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Este saldo inicial está anulado' });
    }

    const total = parseFloat(openingBalance.total_amount);
    const alreadyPaid = parseFloat(openingBalance.paid_amount || 0);
    const remaining = total - alreadyPaid;
    if (remaining <= 0) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Este saldo inicial ya está pagado en su totalidad' });
    }

    const effectiveAmount = Math.min(parseFloat(amount), remaining);
    const paid_amount = alreadyPaid + effectiveAmount;
    const payment_status = paid_amount >= total ? 'paid' : 'partial';

    const { getMappedAccountId, createDraftEntry, postEntry } = require('../../services/accounting/journalEntry.service');
    const isBank = payment_method && /transfer|banco|tarjeta/i.test(payment_method);
    const cashOrBankKey = openingBalance.type === 'receivable'
      ? (isBank ? 'sale_bank_account' : 'sale_cash_account')
      : (isBank ? 'purchase_bank_account' : 'purchase_cash_account');
    const controlKey = openingBalance.type === 'receivable' ? 'sale_receivable' : 'purchase_payable';

    const cashOrBankAccountId = await getMappedAccountId(req.tenant_id, cashOrBankKey, t);
    const controlAccountId = await getMappedAccountId(req.tenant_id, controlKey, t);
    const thirdPartyId = openingBalance.type === 'receivable' ? openingBalance.customer_id : openingBalance.supplier_id;

    const lines = openingBalance.type === 'receivable'
      ? [
          { account_id: cashOrBankAccountId, debit: effectiveAmount, credit: 0, description: 'Abono a saldo inicial de cartera' },
          { account_id: controlAccountId, debit: 0, credit: effectiveAmount, third_party_id: thirdPartyId, description: 'Abono a saldo inicial de cartera' },
        ]
      : [
          { account_id: controlAccountId, debit: effectiveAmount, credit: 0, third_party_id: thirdPartyId, description: 'Pago de saldo inicial a proveedor' },
          { account_id: cashOrBankAccountId, debit: 0, credit: effectiveAmount, description: 'Pago de saldo inicial a proveedor' },
        ];

    const entry = await createDraftEntry(
      req.tenant_id,
      {
        branchId: openingBalance.branch_id,
        entryDate: (payment_date || new Date()).toString().slice(0, 10),
        sourceType: 'opening_balance',
        sourceId: openingBalance.id,
        description: `Abono a saldo inicial — ${openingBalance.reference || openingBalance.id}`,
        lines,
        createdBy: req.user?.id,
      },
      t
    );
    await postEntry(entry.id, req.tenant_id, req.user?.id, t);

    const payment_history = [...(openingBalance.payment_history || [])];
    payment_history.push({
      date: payment_date || new Date(),
      amount: effectiveAmount,
      method: payment_method || 'Efectivo',
      user_id: req.user?.id,
      notes: notes || null,
      journal_entry_id: entry.id,
    });

    await openingBalance.update({ paid_amount, payment_status, payment_history }, { transaction: t });

    await t.commit();
    res.json({ success: true, message: 'Pago registrado', data: openingBalance });
  } catch (error) {
    await t.rollback();
    logger.error(`[openingBalances.registerPayment] ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
};
