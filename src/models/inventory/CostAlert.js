// backend/src/models/inventory/CostAlert.js
// Alerta de variación del costo de compra / precio de venta retenido. Ver
// services/inventory/purchaseCost.service.js y la migración 2026102302.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CostAlert = sequelize.define('CostAlert', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' },
  },
  alert_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['cost_increase', 'cost_decrease', 'price_held']] },
  },
  severity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'warning',
    validate: { isIn: [['info', 'warning', 'critical']] },
  },
  previous_cost: { type: DataTypes.DECIMAL(15, 4), allowNull: true },
  new_cost: { type: DataTypes.DECIMAL(15, 4), allowNull: false },
  variation_pct: { type: DataTypes.DECIMAL(9, 2), allowNull: true },
  previous_price: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  suggested_price: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  price_held: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  source_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [['purchase', 'adjustment']] },
  },
  source_id: { type: DataTypes.UUID, allowNull: true },
  source_number: { type: DataTypes.STRING(50), allowNull: true },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'resolved', 'ignored']] },
  },
  alert_date: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  resolved_date: { type: DataTypes.DATE, allowNull: true },
  resolved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  resolution_notes: { type: DataTypes.TEXT, allowNull: true },
  price_applied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, {
  tableName: 'cost_alerts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = CostAlert;
