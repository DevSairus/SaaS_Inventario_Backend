const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupplierReturnItem = sequelize.define('SupplierReturnItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  return_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'supplier_returns', key: 'id' },
    onDelete: 'CASCADE'
  },
  purchase_item_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'purchase_items', key: 'id' }
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
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  tax: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  }
}, {
  tableName: 'supplier_return_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = SupplierReturnItem;