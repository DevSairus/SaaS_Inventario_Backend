const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InventoryAdjustment = sequelize.define('InventoryAdjustment', {
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
  adjustment_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Número único del ajuste: AJ-2026-00001'
  },
  adjustment_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: {
      isIn: [['entrada', 'salida']]
    },
    comment: 'Tipo: entrada (aumentar stock) o salida (disminuir stock)'
  },
  reason: {
    type: DataTypes.STRING(100),
    allowNull: false,
    comment: 'Razón del ajuste: merma, sobrante, daño, robo, corrección, etc.'
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Bodega donde se realiza el ajuste'
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    },
    comment: 'Usuario que crea el ajuste'
  },
  adjustment_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    comment: 'Fecha del ajuste'
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'draft',
    validate: {
      isIn: [['draft', 'confirmed', 'cancelled']]
    },
    comment: 'Estado: draft, confirmed, cancelled'
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
  tableName: 'inventory_adjustments',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      unique: true,
      fields: ['tenant_id', 'adjustment_number']
    },
    {
      fields: ['tenant_id']
    },
    {
      fields: ['adjustment_date']
    },
    {
      fields: ['status']
    },
    {
      fields: ['warehouse_id']
    }
  ]
});

module.exports = InventoryAdjustment;