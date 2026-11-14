// backend/src/models/payroll/PayrollPeriodEvent.js
//
// 6.1 — Bitácora del flujograma de un período de nómina. Ver
// services/payroll/payrollWorkflow.service.js y la migración 2026111107.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollPeriodEvent = sequelize.define('PayrollPeriodEvent', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  payroll_period_id: { type: DataTypes.UUID, allowNull: false },
  // status_change | advance_blocked | emission_rejected
  event_type: { type: DataTypes.STRING(30), allowNull: false },
  from_status: { type: DataTypes.STRING(20), allowNull: true },
  to_status: { type: DataTypes.STRING(20), allowNull: true },
  user_id: { type: DataTypes.UUID, allowNull: true },
  user_name: { type: DataTypes.STRING(150), allowNull: true },
  note: { type: DataTypes.TEXT, allowNull: true },
  details: { type: DataTypes.JSONB, allowNull: true },
}, {
  tableName: 'payroll_period_events',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: false,
});

module.exports = PayrollPeriodEvent;
