const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerReturn = sequelize.define('CustomerReturn', {
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
  sale_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'sales', key: 'id' }
  },
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' }
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
  tableName: 'customer_returns',
  timestamps: true,
  underscored: true
});

module.exports = CustomerReturn;