const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupplierReturn = sequelize.define('SupplierReturn', {
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
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'purchases', key: 'id' }
  },
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'suppliers', key: 'id' }
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
  credit_note_number: {
    type: DataTypes.STRING(50),
    allowNull: true
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
  // Parte ya pagada de la compra (migración 2026100903): 'refund' = el
  // proveedor devolvió el dinero (refund_*); 'credit' = saldo a favor con el
  // proveedor, aplicado a sus compras pendientes (credit_applications).
  settlement_type: { type: DataTypes.STRING(10), allowNull: true },
  refund_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  refund_method: { type: DataTypes.STRING(50), allowNull: true },
  refund_bank_account_id: { type: DataTypes.UUID, allowNull: true },
  refund_cash_session_id: { type: DataTypes.UUID, allowNull: true },
  refund_branch_id: { type: DataTypes.UUID, allowNull: true },
  refund_date: { type: DataTypes.DATE, allowNull: true },
  credit_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  credit_applied_amount: { type: DataTypes.DECIMAL(15, 2), defaultValue: 0 },
  credit_applications: { type: DataTypes.JSONB, defaultValue: [] },
  // Liquidación fijada al aprobar (migración 2026101001; ver services/returns/returnSettlement.js).
  payable_reduction: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  money_back_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  retention_reversal: { type: DataTypes.JSONB, allowNull: true },
  // Nota de Ajuste al Documento Soporte emitida al aprobar.
  support_adjustment_id: { type: DataTypes.UUID, allowNull: true },
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
  tableName: 'supplier_returns',
  timestamps: true,
  underscored: true
});

module.exports = SupplierReturn;