const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const SupplierReturn = sequelize.define('SupplierReturn', {
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
  return_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  purchase_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'purchases', key: 'id' }
  },
  supplier_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'suppliers', key: 'id' }
  },
  return_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  reason: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  subtotal: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  tax: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending'
  },
  credit_note_number: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  approved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  approved_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejected_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  rejected_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejection_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'supplier_returns',
  timestamps: true,
  underscored: true
});

module.exports = SupplierReturn;