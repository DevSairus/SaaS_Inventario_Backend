const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProductCommissionSettlementItem = sequelize.define('ProductCommissionSettlementItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  settlement_id:  { type: DataTypes.UUID, allowNull: false },
  work_order_id:  { type: DataTypes.UUID, allowNull: true },   // null cuando es venta directa
  order_number:   { type: DataTypes.STRING(50), allowNull: true },
  sale_id:        { type: DataTypes.UUID, allowNull: true },   // solo ventas directas
  sale_number:    { type: DataTypes.STRING(50), allowNull: true },
  product_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  // Detalle por producto (se rellena al crear la liquidación para historial completo)
  product_name: { type: DataTypes.STRING(255), allowNull: true },
  product_sku:  { type: DataTypes.STRING(50),  allowNull: true },
  quantity:     { type: DataTypes.DECIMAL(10, 3), allowNull: true },
  unit_price:   { type: DataTypes.DECIMAL(15, 2), allowNull: true },
}, {
  tableName: 'product_commission_settlement_items',
  timestamps: true,
  updatedAt: false,
  underscored: true,
  indexes: [{ fields: ['settlement_id'] }, { fields: ['work_order_id'] }],
});

module.exports = ProductCommissionSettlementItem;