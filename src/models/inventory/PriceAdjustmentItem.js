// backend/src/models/inventory/PriceAdjustmentItem.js
// Línea de un ajuste de precio de venta: ver la migración 2026103002.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PriceAdjustmentItem = sequelize.define('PriceAdjustmentItem', {
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
  adjustment_id: { type: DataTypes.UUID, allowNull: false },
  product_id: { type: DataTypes.UUID, allowNull: true },
  sku: { type: DataTypes.STRING(100), allowNull: true },
  product_name: { type: DataTypes.STRING(255), allowNull: true },
  previous_price: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  new_price: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  reference_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  cost_source: {
    type: DataTypes.STRING(20),
    allowNull: true,
    validate: { isIn: [['last_purchase', 'average', 'manual']] },
  },
  margin_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
  previous_margin_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
  margin_changed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  margin_method: { type: DataTypes.STRING(20), allowNull: true },
  suggested_price: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  price_includes_tax: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  last_purchase_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  average_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
}, {
  tableName: 'price_adjustment_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PriceAdjustmentItem;
