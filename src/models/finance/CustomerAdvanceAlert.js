// backend/src/models/finance/CustomerAdvanceAlert.js
// Alerta de antigüedad de un Anticipo de Cliente sin aplicar. Ver
// Anticipos-Clientes-Analisis-y-Plan.md §10 (Fase 4, punto 2) y el modelo
// de referencia en models/PayableAlert.js / models/StockAlert.js.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CustomerAdvanceAlert = sequelize.define('CustomerAdvanceAlert', {
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
  customer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'customers', key: 'id' },
  },
  alert_type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'stale',
    validate: { isIn: [['stale', 'very_stale']] },
  },
  severity: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'warning',
    validate: { isIn: [['info', 'warning', 'critical']] },
  },
  balance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  days_since_received: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'active',
    validate: { isIn: [['active', 'resolved', 'ignored']] },
  },
  alert_date: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  resolved_date: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  resolved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  resolution_notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'customer_advance_alerts',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = CustomerAdvanceAlert;
