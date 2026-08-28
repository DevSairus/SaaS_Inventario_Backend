const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const JournalEntry = sequelize.define(
  'JournalEntry',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },
    entry_number: { type: DataTypes.STRING(50), allowNull: false },
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },
    period_id: { type: DataTypes.UUID, allowNull: true },
    source_type: {
      // VARCHAR(40) desde 2026082104-widen-journal-entry-source-type.js —
      // 'customer_advance_application' (29 chars) no cabía en VARCHAR(20).
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'manual',
      validate: { isIn: [['sale', 'purchase', 'expense', 'cash_session', 'payment', 'customer_return', 'supplier_return', 'credit_note', 'debit_note', 'manual', 'adjustment', 'customer_advance', 'customer_advance_application', 'customer_advance_refund']] },
    },
    source_id: { type: DataTypes.UUID, allowNull: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'draft',
      validate: { isIn: [['draft', 'posted', 'voided']] },
    },
    total_debit: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    total_credit: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    created_by: { type: DataTypes.UUID, allowNull: true },
    posted_by: { type: DataTypes.UUID, allowNull: true },
    posted_at: { type: DataTypes.DATE, allowNull: true },
    voided_by: { type: DataTypes.UUID, allowNull: true },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    void_reason: { type: DataTypes.TEXT, allowNull: true },
    // Si ESTE asiento es una reversión, apunta al asiento original que contrarresta.
    reversal_of_entry_id: { type: DataTypes.UUID, allowNull: true },
    // Si ESTE asiento YA FUE reversado, apunta al asiento de reversión que lo contrarresta.
    reversed_by_entry_id: { type: DataTypes.UUID, allowNull: true },
  },

  {
    tableName: 'journal_entries',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['tenant_id', 'entry_number'] }],
  }
);

module.exports = JournalEntry;
