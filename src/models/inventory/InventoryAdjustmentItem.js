const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InventoryAdjustmentItem = sequelize.define('InventoryAdjustmentItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  adjustment_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'inventory_adjustments',
      key: 'id'
    },
    onDelete: 'CASCADE'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'products',
      key: 'id'
    }
  },
  quantity: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Cantidad a ajustar (siempre positivo)'
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Costo unitario del producto al momento del ajuste'
  },
  total_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Costo total del item (quantity * unit_cost)'
  },
  reason: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Razón específica para este producto'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'inventory_adjustment_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['adjustment_id']
    },
    {
      fields: ['product_id']
    }
  ]
});

module.exports = InventoryAdjustmentItem;