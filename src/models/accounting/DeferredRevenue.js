// Ingreso recibido por anticipado que se causa mes a mes (ver
// services/accounting/deferredRevenue.service.js y la migración 2026111601).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const DeferredRevenue = sequelize.define('DeferredRevenue', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  sale_id: { type: DataTypes.UUID, allowNull: false },
  branch_id: { type: DataTypes.UUID, allowNull: true },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  description: { type: DataTypes.STRING(300), allowNull: false },
  liability_account_id: { type: DataTypes.UUID, allowNull: false },
  revenue_account_id: { type: DataTypes.UUID, allowNull: false },
  total_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false },
  months: { type: DataTypes.INTEGER, allowNull: false },
  start_date: { type: DataTypes.DATEONLY, allowNull: false },
  months_amortized: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  amortized_amount: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'finished', 'cancelled']] } },
  last_error: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'deferred_revenues', underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = DeferredRevenue;
