// backend/src/models/accounting/OpeningBalance.js
//
// Saldo con el que arranca un cliente (cartera por cobrar) o un proveedor
// (cuentas por pagar) al momento de empezar a usar Pitbox, cuando ya venían
// operando antes. No es una Sale/Purchase real (evita disparar inventario,
// impuestos, numeración): es un renglón de "deuda vieja" que se fusiona en las
// pantallas de Cartera/CxP (ver accounts-receivable.controller.js /
// accountsPayable.controller.js) y que respalda su contrapartida contable en
// un JournalEntry contra la cuenta puente (ver openingBalance.service.js).

const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const OpeningBalance = sequelize.define(
  'OpeningBalance',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenant_id: { type: DataTypes.UUID, allowNull: false },
    branch_id: { type: DataTypes.UUID, allowNull: true },
    type: {
      type: DataTypes.STRING(10),
      allowNull: false,
      validate: { isIn: [['receivable', 'payable']] },
    },
    customer_id: { type: DataTypes.UUID, allowNull: true },
    supplier_id: { type: DataTypes.UUID, allowNull: true },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    description: { type: DataTypes.STRING(500), allowNull: true },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    paid_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
    payment_status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pending',
      validate: { isIn: [['pending', 'partial', 'paid']] },
    },
    payment_history: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    journal_entry_id: { type: DataTypes.UUID, allowNull: false },
    status: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'active',
      validate: { isIn: [['active', 'voided']] },
    },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    voided_by: { type: DataTypes.UUID, allowNull: true },
    void_reason: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: 'opening_balances',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['tenant_id'] },
      { fields: ['tenant_id', 'type'] },
      { fields: ['customer_id'] },
      { fields: ['supplier_id'] },
    ],
  }
);

module.exports = OpeningBalance;
