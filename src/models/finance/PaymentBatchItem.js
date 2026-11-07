// backend/src/models/finance/PaymentBatchItem.js
// Compra o gasto dentro de un lote de pagos, con los datos bancarios del
// proveedor congelados al armar el lote (migración 2026110605).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PaymentBatchItem = sequelize.define('PaymentBatchItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  batch_id: { type: DataTypes.UUID, allowNull: false },
  document_type: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [['purchase', 'expense']] } },
  document_id: { type: DataTypes.UUID, allowNull: false },
  document_number: { type: DataTypes.STRING(60), allowNull: true },
  supplier_id: { type: DataTypes.UUID, allowNull: true },
  beneficiary_name: { type: DataTypes.STRING(255), allowNull: true },
  beneficiary_tax_id: { type: DataTypes.STRING(30), allowNull: true },
  beneficiary_doc_type: { type: DataTypes.STRING(5), allowNull: true },
  beneficiary_email: { type: DataTypes.STRING(255), allowNull: true },
  bank_name: { type: DataTypes.STRING(255), allowNull: true },
  account_type: { type: DataTypes.STRING(50), allowNull: true },
  account_number: { type: DataTypes.STRING(100), allowNull: true },
  amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
}, { tableName: 'payment_batch_items', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = PaymentBatchItem;
