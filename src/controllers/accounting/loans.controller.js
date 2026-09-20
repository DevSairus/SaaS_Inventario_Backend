// backend/src/controllers/accounting/loans.controller.js
//
// Créditos y Amortización — Fase 2 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md — Fase 2.
//
// Endpoints:
//   GET    /api/accounting/loans                              → list
//   GET    /api/accounting/loans/report                        → report
//   GET    /api/accounting/loans/:id                            → getById (incluye tabla de amortización)
//   POST   /api/accounting/loans                                → create (genera la tabla completa)
//   POST   /api/accounting/loans/:id/installments/:instId/pay   → payInstallment

const { Loan, LoanInstallment, ChartOfAccount, JournalEntry, sequelize } = require('../../models');
const { Op } = require('sequelize');
const { generateAmortizationSchedule } = require('../../services/accounting/loanAmortization.service');
const { generateLoanPaymentEntry } = require('../../services/accounting/autoEntries.service');
const logger = require('../../config/logger');

const LOAN_TYPES = ['bancario', 'tercero'];

const ACCOUNT_INCLUDES = [
  { model: ChartOfAccount, as: 'liability_account', attributes: ['id', 'code', 'name'] },
  { model: ChartOfAccount, as: 'interest_expense_account', attributes: ['id', 'code', 'name'] },
];

function pendingBalance(loan) {
  const last = (loan.installments || [])
    .filter((i) => i.status !== 'pagada')
    .sort((a, b) => a.installment_number - b.installment_number)[0];
  // Si todas están pagadas, el saldo pendiente es 0. Si no, el saldo antes
  // de la primera cuota no pagada es exactamente lo que falta por pagar.
  if (!last) return 0;
  const prev = (loan.installments || []).find((i) => i.installment_number === last.installment_number - 1);
  return prev ? Number(prev.balance_after) : Number(loan.principal_amount);
}

// GET /loans
exports.list = async (req, res) => {
  try {
    const where = { tenant_id: req.tenant_id };
    if (req.query.status) where.status = req.query.status;
    if (req.query.branch_id) where.branch_id = req.query.branch_id;

    const loans = await Loan.findAll({
      where,
      include: [...ACCOUNT_INCLUDES, { model: LoanInstallment, as: 'installments', attributes: ['installment_number', 'status', 'balance_after', 'due_date'] }],
      order: [['disbursement_date', 'DESC']],
    });

    const data = loans.map((l) => {
      const json = l.toJSON();
      const pendingCount = json.installments.filter((i) => i.status !== 'pagada').length;
      return { ...json, pending_balance: pendingBalance(json), pending_installments: pendingCount };
    });

    res.json({ success: true, data });
  } catch (error) {
    logger.error('Error en loans.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al listar créditos', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /loans/report — saldo total pendiente por crédito + próximas cuotas a vencer (30 días)
exports.report = async (req, res) => {
  try {
    const loans = await Loan.findAll({
      where: { tenant_id: req.tenant_id, status: 'activo' },
      include: [{ model: LoanInstallment, as: 'installments' }],
    });

    const byLoan = loans.map((l) => {
      const json = l.toJSON();
      return {
        id: json.id,
        lender_name: json.lender_name,
        loan_type: json.loan_type,
        pending_balance: pendingBalance(json),
        pending_installments: json.installments.filter((i) => i.status !== 'pagada').length,
      };
    });

    const totalPendingBalance = byLoan.reduce((sum, l) => sum + l.pending_balance, 0);

    const in30Days = new Date();
    in30Days.setUTCDate(in30Days.getUTCDate() + 30);
    const in30DaysStr = in30Days.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const upcoming = await LoanInstallment.findAll({
      where: {
        tenant_id: req.tenant_id,
        status: ['pendiente', 'vencida'],
        due_date: { [Op.between]: [todayStr, in30DaysStr] },
      },
      include: [{ model: Loan, as: 'loan', attributes: ['id', 'lender_name'], where: { status: 'activo' } }],
      order: [['due_date', 'ASC']],
    });

    res.json({
      success: true,
      data: { by_loan: byLoan, total_pending_balance: totalPendingBalance, upcoming_installments: upcoming },
    });
  } catch (error) {
    logger.error('Error en loans.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al generar el reporte de créditos', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// GET /loans/:id
exports.getById = async (req, res) => {
  try {
    const loan = await Loan.findOne({
      where: { id: req.params.id, tenant_id: req.tenant_id },
      include: ACCOUNT_INCLUDES,
    });
    if (!loan) return res.status(404).json({ success: false, message: 'Crédito no encontrado' });

    const installments = await LoanInstallment.findAll({
      where: { loan_id: loan.id },
      include: [{ model: JournalEntry, as: 'journal_entry', attributes: ['id', 'entry_number', 'status'] }],
      order: [['installment_number', 'ASC']],
    });

    const json = loan.toJSON();
    res.json({
      success: true,
      data: { ...json, installments, pending_balance: pendingBalance({ ...json, installments }) },
    });
  } catch (error) {
    logger.error('Error en loans.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el crédito', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /loans
exports.create = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const {
      lender_name, loan_type, branch_id, principal_amount, annual_interest_rate, term_months,
      disbursement_date, first_payment_date, liability_account_id, interest_expense_account_id,
    } = req.body;

    if (!lender_name) return res.status(400).json({ success: false, message: 'El nombre de la entidad/tercero es obligatorio' });
    if (!loan_type || !LOAN_TYPES.includes(loan_type)) {
      return res.status(400).json({ success: false, message: `Tipo de crédito inválido. Debe ser: ${LOAN_TYPES.join(', ')}` });
    }
    if (!principal_amount || parseFloat(principal_amount) <= 0) {
      return res.status(400).json({ success: false, message: 'El monto del crédito debe ser mayor a 0' });
    }
    if (annual_interest_rate === undefined || annual_interest_rate === null || parseFloat(annual_interest_rate) < 0) {
      return res.status(400).json({ success: false, message: 'La tasa de interés anual es obligatoria (puede ser 0)' });
    }
    if (!term_months || parseInt(term_months, 10) <= 0) {
      return res.status(400).json({ success: false, message: 'El plazo (en meses) debe ser mayor a 0' });
    }
    if (!disbursement_date) return res.status(400).json({ success: false, message: 'La fecha de desembolso es obligatoria' });
    if (!first_payment_date) return res.status(400).json({ success: false, message: 'La fecha de la primera cuota es obligatoria' });
    if (!liability_account_id || !interest_expense_account_id) {
      return res.status(400).json({ success: false, message: 'Debes seleccionar la cuenta del pasivo y la cuenta de gasto por intereses' });
    }

    const [liabilityAccount, interestAccount] = await Promise.all([
      ChartOfAccount.findOne({ where: { id: liability_account_id, tenant_id: req.tenant_id }, transaction }),
      ChartOfAccount.findOne({ where: { id: interest_expense_account_id, tenant_id: req.tenant_id }, transaction }),
    ]);
    if (!liabilityAccount) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cuenta del pasivo no encontrada' });
    }
    if (!interestAccount) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Cuenta de gasto por intereses no encontrada' });
    }

    const loan = await Loan.create(
      {
        tenant_id: req.tenant_id,
        branch_id: branch_id || null,
        lender_name,
        loan_type,
        principal_amount: parseFloat(principal_amount),
        annual_interest_rate: parseFloat(annual_interest_rate),
        term_months: parseInt(term_months, 10),
        amortization_system: 'frances',
        disbursement_date,
        first_payment_date,
        liability_account_id,
        interest_expense_account_id,
        status: 'activo',
        created_by: req.user_id || req.user?.id || null,
      },
      { transaction }
    );

    await generateAmortizationSchedule(loan, req.tenant_id, transaction);

    await transaction.commit();

    const installments = await LoanInstallment.findAll({ where: { loan_id: loan.id }, order: [['installment_number', 'ASC']] });
    res.status(201).json({ success: true, data: { ...loan.toJSON(), installments } });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error en loans.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al crear el crédito', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

// POST /loans/:id/installments/:installmentId/pay
// Pago de cuota completa únicamente (sin pago parcial/anticipado -- fuera
// de alcance de esta fase, ver plan). Permite fecha de pago distinta al
// due_date (pago manual con fecha real).
exports.payInstallment = async (req, res) => {
  try {
    const loan = await Loan.findOne({ where: { id: req.params.id, tenant_id: req.tenant_id } });
    if (!loan) return res.status(404).json({ success: false, message: 'Crédito no encontrado' });

    const installment = await LoanInstallment.findOne({
      where: { id: req.params.installmentId, loan_id: loan.id },
    });
    if (!installment) return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
    if (installment.status === 'pagada') {
      return res.status(409).json({ success: false, message: 'Esta cuota ya está pagada' });
    }

    const { payment_method, payment_date } = req.body;
    const paidDate = payment_date || new Date().toISOString().slice(0, 10);

    await installment.update({ status: 'pagada', paid_date: paidDate, payment_method: payment_method || null });

    // Si esta era la última cuota pendiente, el crédito queda 'pagado'.
    const stillPending = await LoanInstallment.count({ where: { loan_id: loan.id, status: ['pendiente', 'vencida'] } });
    if (stillPending === 0) {
      await loan.update({ status: 'pagado' });
    }

    // Asiento contable, fire-and-forget (mismo criterio que el resto del
    // motor): si falta el mapeo de caja/bancos, la cuota queda marcada
    // pagada igual -- solo falta el asiento, regenerable después.
    const userId = req.user_id || req.user?.id || null;
    try {
      const entry = await generateLoanPaymentEntry(installment, loan, payment_method, req.tenant_id, userId, { rethrow: true });
      if (entry) await installment.update({ journal_entry_id: entry.id });
    } catch (error) {
      logger.warn(`[loans] No se pudo generar el asiento del pago (cuota ${installment.id}): ${error.message}`);
    }

    res.json({ success: true, data: installment, message: `Cuota ${installment.installment_number} registrada como pagada.` });
  } catch (error) {
    logger.error('Error en loans.controller.js:', error);
    res.status(500).json({ success: false, message: 'Error al registrar el pago de la cuota', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
