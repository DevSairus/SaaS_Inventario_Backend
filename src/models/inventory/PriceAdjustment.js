// backend/src/models/inventory/PriceAdjustment.js
// Ajuste de precio de venta AJP- (solo cambia base_price): ver la migración
// 2026103002 y services/inventory/priceAdjustment.service.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PriceAdjustment = sequelize.define('PriceAdjustment', {
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
  adjustment_number: { type: DataTypes.STRING(30), allowNull: false },
  reason: { type: DataTypes.STRING(255), allowNull: false },
  notes: { type: DataTypes.TEXT, allowNull: true },
  items_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'price_adjustments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PriceAdjustment;
