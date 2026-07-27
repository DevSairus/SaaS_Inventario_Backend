const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Warehouse = sequelize.define('Warehouse', {
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
  branch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'branches',
      key: 'id'
    },
    comment: 'Sede a la que pertenece esta bodega. Una sede puede tener varias bodegas; is_default marca cuál se usa automáticamente.'
  },
  code: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  city: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  phone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  manager_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  is_main: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  is_default: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Bodega que se asigna automáticamente en OT/ventas cuando no se especifica una para la sede (branch_id). Máximo una por sede.'
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'warehouses',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Warehouse;