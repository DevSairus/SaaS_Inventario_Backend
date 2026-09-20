// backend/src/models/accounting/LoanInstallment.js
//
// Una cuota de la tabla de amortización de un Loan. La tabla completa se
// genera de una sola vez al crear el crédito (sistema francés = fórmula
// cerrada, no requiere iteración día a día) — ver
// services/accounting/loanAmortization.service.js.
//
// `status: 'vencida'` no se calcula al leer: lo actualiza el job diario
// "loan-installments-overdue-check" (jobs/scheduler.js) para cuotas
// 'pendiente' cuyo due_date ya pasó.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const LoanInstallment = sequelize.define(
  'LoanInstallment',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    loan_id: { type: DataTypes.UUID, allowNull: false },

    installment_number: { type: DataTypes.INTEGER, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: false },

    principal_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    interest_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    balance_after: { type: DataTypes.DECIMAL(15, 2), allowNull: false },

    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pendiente',
      validate: { isIn: [['pendiente', 'pagada', 'vencida']] },
    },

    paid_date: { type: DataTypes.DATEONLY, allowNull: true },
    payment_method: { type: DataTypes.STRING(50), allowNull: true },

    // Nullable: la cuota queda marcada 'pagada' igual aunque falte generar
    // el asiento (fire-and-forget, mismo criterio que el resto del motor).
    journal_entry_id: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'loan_installments',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['loan_id'] },
      { fields: ['status', 'due_date'] },
      { unique: true, fields: ['loan_id', 'installment_number'] },
    ],
  }
);

module.exports = LoanInstallment;
