const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const Transfer = sequelize.define('Transfer', {
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
  transfer_number: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true
  },
  from_warehouse_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'warehouses', key: 'id' }
  },
  to_warehouse_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'warehouses', key: 'id' }
  },
  transfer_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  sent_date: {
    type: DataTypes.DATE,
    allowNull: true
  },
  received_date: {
    type: DataTypes.DATE,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'draft'
  },
  shipping_method: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  tracking_number: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  shipping_notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  receiving_notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  sent_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  },
  received_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' }
  }
}, {
  tableName: 'transfers',
  timestamps: true,
  underscored: true
});

module.exports = Transfer;