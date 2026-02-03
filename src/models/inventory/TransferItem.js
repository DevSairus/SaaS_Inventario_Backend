const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const TransferItem = sequelize.define('TransferItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  transfer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'transfers', key: 'id' },
    onDelete: 'CASCADE'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  quantity_sent: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  },
  quantity_received: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false
  }
}, {
  tableName: 'transfer_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false
});

module.exports = TransferItem;