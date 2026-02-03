const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const InternalConsumption = sequelize.define('InternalConsumption', {
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
  consumption_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  warehouse_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'warehouses', key: 'id' }
  },
  department: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  consumption_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  purpose: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  total_cost: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending'
  },
  requested_by: {
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
  tableName: 'internal_consumptions',
  timestamps: true,
  underscored: true
});

module.exports = InternalConsumption;