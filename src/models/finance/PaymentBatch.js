// backend/src/models/finance/PaymentBatch.js
// Lote de pagos a proveedores (migración 2026110605). Ver services/payments/paymentBatches.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BATCH_STATUSES = ['draft', 'pending_approval', 'approved', 'exported', 'paid', 'cancelled'];

const PaymentBatch = sequelize.define('PaymentBatch', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  batch_number: { type: DataTypes.STRING(30), allowNull: false },
  bank_account_id: { type: DataTypes.UUID, allowNull: false },
  debit_account_type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'savings', validate: { isIn: [['savings', 'checking']] } },
  format_key: { type: DataTypes.STRING(60), allowNull: false },
  payment_date: { type: DataTypes.DATEONLY, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft', validate: { isIn: [BATCH_STATUSES] } },
  total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
  submitted_at: { type: DataTypes.DATE, allowNull: true },
  approved_by: { type: DataTypes.UUID, allowNull: true },
  approved_at: { type: DataTypes.DATE, allowNull: true },
  rejection_reason: { type: DataTypes.TEXT, allowNull: true },
  exported_at: { type: DataTypes.DATE, allowNull: true },
  exported_by: { type: DataTypes.UUID, allowNull: true },
  paid_at: { type: DataTypes.DATE, allowNull: true },
  paid_by: { type: DataTypes.UUID, allowNull: true },
  cancelled_at: { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'payment_batches', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

PaymentBatch.STATUSES = BATCH_STATUSES;
module.exports = PaymentBatch;
