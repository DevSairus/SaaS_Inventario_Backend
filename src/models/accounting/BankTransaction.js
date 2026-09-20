// backend/src/models/accounting/BankTransaction.js
//
// Movimiento importado del extracto bancario real -- Fase 3 del plan de
// Contabilidad Pitbox. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 3.
//
// `amount`: positivo = entrada, negativo = salida (mismo signo que ya usa
// cashReconciliation.service.js para las cuentas de caja/bancos).
// `raw_row`: la fila original completa del archivo, para poder auditar un
// import sin tener que volver a abrir el Excel/CSV original.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BankTransaction = sequelize.define(
  'BankTransaction',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    bank_account_id: { type: DataTypes.UUID, allowNull: false },

    transaction_date: { type: DataTypes.DATEONLY, allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    raw_row: { type: DataTypes.JSONB, allowNull: true },

    reconciliation_status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pendiente',
      validate: { isIn: [['pendiente', 'conciliada', 'ignorada']] },
    },

    matched_journal_entry_line_id: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'bank_transactions',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['bank_account_id', 'reconciliation_status'] },
      { fields: ['bank_account_id', 'transaction_date'] },
    ],
  }
);

module.exports = BankTransaction;
