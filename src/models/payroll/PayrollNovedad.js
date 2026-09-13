// backend/src/models/payroll/PayrollNovedad.js
//
// Captura de novedades por empleado/periodo (horas extra, bonificaciones,
// licencias, libranzas, días no remunerados, etc.) — ver comentario de la
// migración 20260830270000 para el porqué. `dian_category` debe ser una
// clave válida de DIAN_CATEGORY_MAP en payrollService.js, o NULL si la fila
// es puramente `unpaid_days`.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PayrollNovedad = sequelize.define('PayrollNovedad', {
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
  employee_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'employees', key: 'id' },
  },
  payroll_period_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'payroll_periods', key: 'id' },
  },
  payroll_concept_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'payroll_concepts', key: 'id' },
  },
  dian_category: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Clave de DIAN_CATEGORY_MAP en payrollService.js — NULL si esta fila es puramente unpaid_days',
  },
  payload: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Estructura exacta que espera el sub-builder de payrollXmlBuilder.js para dian_category',
  },
  unpaid_days: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 0,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'payroll_novedades',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['tenant_id'] },
    { fields: ['tenant_id', 'payroll_period_id'] },
    { fields: ['tenant_id', 'employee_id', 'payroll_period_id'] },
  ],
});

module.exports = PayrollNovedad;