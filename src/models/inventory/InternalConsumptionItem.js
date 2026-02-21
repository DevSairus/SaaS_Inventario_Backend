const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InternalConsumptionItem = sequelize.define('InternalConsumptionItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  consumption_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'internal_consumptions', key: 'id' },
    onDelete: 'CASCADE'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  quantity: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  total_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'internal_consumption_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = InternalConsumptionItem;