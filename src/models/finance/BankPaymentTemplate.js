// backend/src/models/finance/BankPaymentTemplate.js
// Formato propio de archivo plano de pagos (columnas separadas por
// delimitador). Migración 2026110605; ver services/payments/bankFileFormats.js.
// columns: [{ source, label?, value?, format? }]
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BankPaymentTemplate = sequelize.define('BankPaymentTemplate', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  name: { type: DataTypes.STRING(120), allowNull: false },
  bank_name: { type: DataTypes.STRING(100), allowNull: true },
  delimiter: { type: DataTypes.STRING(5), allowNull: false, defaultValue: ',' },
  extension: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'csv' },
  include_header: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  savings_code: { type: DataTypes.STRING(20), allowNull: true },
  checking_code: { type: DataTypes.STRING(20), allowNull: true },
  columns: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'bank_payment_templates', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = BankPaymentTemplate;
