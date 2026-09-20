// backend/src/models/accounting/Loan.js
//
// Crédito (bancario o con tercero) — Fase 2 del plan de Contabilidad
// Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 2.
//
// `liability_account_id` / `interest_expense_account_id` se eligen por
// crédito (no vía AccountMapping global) -- mismo criterio que
// asset_account_id/accumulated_depreciation_account_id en FixedAsset.js:
// el pasivo financiero puede necesitar una subcuenta por entidad
// financiera, y no siempre todos los créditos de un tenant caen en la
// misma cuenta.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Loan = sequelize.define(
  'Loan',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },

    lender_name: { type: DataTypes.STRING(150), allowNull: false },
    loan_type: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: { isIn: [['bancario', 'tercero']] },
    },

    principal_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    annual_interest_rate: { type: DataTypes.DECIMAL(7, 4), allowNull: false },
    term_months: { type: DataTypes.INTEGER, allowNull: false },

    // Único valor por ahora a propósito: deja el campo listo para
    // 'aleman'/'americano' después sin migrar de nuevo.
    amortization_system: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'frances',
      validate: { isIn: [['frances']] },
    },

    disbursement_date: { type: DataTypes.DATEONLY, allowNull: false },
    first_payment_date: { type: DataTypes.DATEONLY, allowNull: false },

    liability_account_id: { type: DataTypes.UUID, allowNull: false },
    interest_expense_account_id: { type: DataTypes.UUID, allowNull: false },

    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'activo',
      validate: { isIn: [['activo', 'pagado', 'cancelado']] },
    },

    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'loans',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['tenant_id', 'status'] },
    ],
  }
);

module.exports = Loan;
