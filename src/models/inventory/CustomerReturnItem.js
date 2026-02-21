const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerReturnItem = sequelize.define('CustomerReturnItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  return_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customer_returns', key: 'id' }
  },
  sale_item_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'sale_items', key: 'id' }
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
  unit_price: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  condition: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  destination: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'inventory'
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  tax: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  }
}, {
  tableName: 'customer_return_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = CustomerReturnItem;