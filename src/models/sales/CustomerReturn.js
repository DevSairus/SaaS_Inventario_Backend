const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerReturn = sequelize.define('CustomerReturn', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  return_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  sale_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'sales', key: 'id' }
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' }
  },
  return_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  reason: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  tax: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  // Parte del descuento global de la venta (services/sales/globalDiscount.service.js);
  // total_amount = subtotal + tax - discount_amount.
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending'
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  approved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  approved_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejected_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  rejected_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejection_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Parte ya pagada de la devolución (migración 2026100902): 'refund' =
  // dinero devuelto (refund_*), 'credit' = saldo a favor (credit_advance_id).
  settlement_type: { type: DataTypes.STRING(10), allowNull: true },
  refund_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  refund_method: { type: DataTypes.STRING(50), allowNull: true },
  refund_bank_account_id: { type: DataTypes.UUID, allowNull: true },
  refund_cash_session_id: { type: DataTypes.UUID, allowNull: true },
  refund_branch_id: { type: DataTypes.UUID, allowNull: true },
  refund_date: { type: DataTypes.DATE, allowNull: true },
  credit_advance_id: { type: DataTypes.UUID, allowNull: true },
  // Nota crédito electrónica emitida al aprobar sobre una factura aceptada.
  credit_note_sale_id: { type: DataTypes.UUID, allowNull: true },
  // Liquidación fijada al aprobar (migración 2026101001; ver services/returns/returnSettlement.js).
  receivable_reduction: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  money_back_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  retention_reversal: { type: DataTypes.JSONB, allowNull: true },
  // Reversión de la devolución (status 'reversed', migración 2026101002).
  reversed_by: { type: DataTypes.UUID, allowNull: true },
  reversed_at: { type: DataTypes.DATE, allowNull: true },
  reversal_reason: { type: DataTypes.TEXT, allowNull: true },
  reversal_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  reversal_method: { type: DataTypes.STRING(50), allowNull: true },
  reversal_bank_account_id: { type: DataTypes.UUID, allowNull: true },
  reversal_cash_session_id: { type: DataTypes.UUID, allowNull: true },
  reversal_branch_id: { type: DataTypes.UUID, allowNull: true },
  reversal_entry_id: { type: DataTypes.UUID, allowNull: true }
}, {
  tableName: 'customer_returns',
  timestamps: true,
  underscored: true
});

module.exports = CustomerReturn;