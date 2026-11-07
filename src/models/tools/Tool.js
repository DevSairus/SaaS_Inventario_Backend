// backend/src/models/tools/Tool.js
// Hoja de vida de una herramienta (migración 2026110608). Ver
// services/tools/tools.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Tool = sequelize.define('Tool', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  code: { type: DataTypes.STRING(30), allowNull: false },
  name: { type: DataTypes.STRING(200), allowNull: false },
  category: { type: DataTypes.STRING(100), allowNull: true },
  brand: { type: DataTypes.STRING(100), allowNull: true },
  model: { type: DataTypes.STRING(100), allowNull: true },
  serial_number: { type: DataTypes.STRING(100), allowNull: true },
  tracking: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'individual', validate: { isIn: [['individual', 'quantity']] } },
  quantity_total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active', validate: { isIn: [['active', 'maintenance', 'retired']] } },
  cost_mode: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'zero', validate: { isIn: [['zero', 'expense', 'fixed_asset']] } },
  acquisition_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  acquisition_date: { type: DataTypes.DATEONLY, allowNull: true },
  acquisition_reference: { type: DataTypes.STRING(100), allowNull: true },
  supplier_id: { type: DataTypes.UUID, allowNull: true },
  fixed_asset_id: { type: DataTypes.UUID, allowNull: true },
  usage_rate_daily: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  location: { type: DataTypes.STRING(150), allowNull: true },
  requires_calibration: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  calibration_interval_months: { type: DataTypes.INTEGER, allowNull: true },
  next_calibration_date: { type: DataTypes.DATEONLY, allowNull: true },
  maintenance_interval_months: { type: DataTypes.INTEGER, allowNull: true },
  next_maintenance_date: { type: DataTypes.DATEONLY, allowNull: true },
  retired_at: { type: DataTypes.DATEONLY, allowNull: true },
  retirement_reason: { type: DataTypes.STRING(255), allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'tools', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = Tool;
