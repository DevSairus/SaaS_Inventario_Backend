// backend/src/models/payroll/PayrollVacationSettlement.js
//
// 6.5 — Liquidación y pago directo de vacaciones fuera de un período de nómina.
// Ver services/payroll/payrollVacationService.js y la migración 2026111106.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollVacationSettlement = sequelize.define('PayrollVacationSettlement', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false },
  employee_id: { type: DataTypes.UUID, allowNull: false },
  doc_number: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'borrador', validate: { isIn: [['borrador', 'pagada', 'anulada']] } },
  start_date: { type: DataTypes.DATEONLY, allowNull: true },
  end_date: { type: DataTypes.DATEONLY, allowNull: true },
  days_enjoyed: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
  days_compensated: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
  base_salary: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  daily_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  value_enjoyed: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  value_compensated: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  total_value: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  payment_date: { type: DataTypes.DATEONLY, allowNull: true },
  bank_account_id: { type: DataTypes.UUID, allowNull: true },
  reference: { type: DataTypes.STRING(100), allowNull: true },
  journal_entry_id: { type: DataTypes.UUID, allowNull: true },
  payroll_period_id: { type: DataTypes.UUID, allowNull: true },
  novedad_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
  paid_by: { type: DataTypes.UUID, allowNull: true },
  voided_by: { type: DataTypes.UUID, allowNull: true },
  voided_at: { type: DataTypes.DATE, allowNull: true },
  void_reason: { type: DataTypes.TEXT, allowNull: true },
}, {
  tableName: 'payroll_vacation_settlements',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = PayrollVacationSettlement;
