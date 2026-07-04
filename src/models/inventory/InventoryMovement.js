const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InventoryMovement = sequelize.define('InventoryMovement', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' }
  },
  movement_number: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  movement_type: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  direction: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'in',
    validate: { isIn: [['in', 'out', 'none']] }
  },
  movement_reason: {
    type: DataTypes.STRING(100),
    allowNull: false,
    defaultValue: 'movimiento'
  },
  reference_type: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  reference_id: {
    type: DataTypes.UUID,
    allowNull: true
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'products', key: 'id' }
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: false
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
  previous_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  new_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' }
  },
  movement_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW
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
  tableName: 'inventory_movements',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = InventoryMovement;
