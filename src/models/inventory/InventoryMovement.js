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
    references: {
      model: 'tenants',
      key: 'id'
    }
  },
  movement_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número único del movimiento: MOV-2026-00001'
  },
  movement_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: {
      isIn: [['entrada', 'salida']]
    },
    comment: 'Tipo de movimiento: entrada o salida'
  },
  movement_reason: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Razón del movimiento: purchase_receipt, sale, adjustment_in, etc.'
  },
  reference_type: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Tipo de documento relacionado: purchase, sale, adjustment, transfer'
  },
  reference_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'ID del documento relacionado'
  },
  product_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'products',
      key: 'id'
    }
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Bodega donde ocurre el movimiento'
  },
  quantity: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Cantidad del movimiento (siempre positivo)'
  },
  unit_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Costo unitario al momento del movimiento'
  },
  total_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Costo total del movimiento (quantity * unit_cost)'
  },
  previous_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Stock antes del movimiento'
  },
  new_stock: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    comment: 'Stock después del movimiento'
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    },
    comment: 'Usuario que registró el movimiento'
  },
  movement_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: 'Fecha del movimiento'
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
  updatedAt: 'updated_at',
  indexes: [
    {
      unique: true,
      fields: ['tenant_id', 'movement_number']
    },
    {
      fields: ['tenant_id']
    },
    {
      fields: ['product_id']
    },
    {
      fields: ['movement_date']
    },
    {
      fields: ['movement_type']
    },
    {
      fields: ['reference_type', 'reference_id']
    },
    {
      fields: ['warehouse_id']
    }
  ]
});

module.exports = InventoryMovement;