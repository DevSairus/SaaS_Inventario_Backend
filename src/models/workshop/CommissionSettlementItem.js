const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CommissionSettlementItem = sequelize.define('CommissionSettlementItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  settlement_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  work_order_id: {
    type: DataTypes.UUID,
    allowNull: true,   // nullable cuando viene de venta directa
  },
  order_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  sale_id: {
    type: DataTypes.UUID,
    allowNull: true,   // solo cuando es venta directa sin OT
  },
  sale_number: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  labor_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
}, {
  tableName: 'commission_settlement_items',
  timestamps: true,
  updatedAt: false,
  underscored: true,
  indexes: [
    { fields: ['settlement_id'] },
    { fields: ['work_order_id'] },
  ],
});

module.exports = CommissionSettlementItem;