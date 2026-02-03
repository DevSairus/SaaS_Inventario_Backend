const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PurchaseItem = sequelize.define('PurchaseItem', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'purchases',
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
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    validate: {
      min: 0
    }
  },
  received_quantity: {
    type: DataTypes.DECIMAL(15, 4),
    defaultValue: 0,
    validate: {
      min: 0
    }
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: false,
    comment: 'Precio unitario de compra'
  },
  tax_rate: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
    comment: 'Tasa de IVA (%)'
  },
  tax_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
    comment: 'Monto del IVA'
  },
  discount_percentage: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0
  },
  discount_amount: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
    comment: 'quantity * unit_cost - discount'
  },
  total: {
    type: DataTypes.DECIMAL(15, 2),
    defaultValue: 0,
    comment: 'subtotal + tax_amount'
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
  tableName: 'purchase_items',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['purchase_id']
    },
    {
      fields: ['product_id']
    }
  ]
});

module.exports = PurchaseItem;