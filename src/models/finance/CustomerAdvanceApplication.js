// backend/src/models/finance/CustomerAdvanceApplication.js
// Tabla puente N:M anticipo↔factura: un anticipo puede repartirse entre
// varias ventas y una venta puede pagarse con varios anticipos. Ver
// Anticipos-Clientes-Analisis-y-Plan.md §4.2.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerAdvanceApplication = sequelize.define('CustomerAdvanceApplication', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
  },
  advance_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customer_advances', key: 'id' },
  },
  sale_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'sales', key: 'id' },
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  application_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'reversed']] },
  },
  reversed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  reversed_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  reversed_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'customer_advance_applications',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = CustomerAdvanceApplication;
