// backend/src/models/projects/ProjectLaborAllocation.js
// Reparto del costo de nómina de un periodo entre proyectos (migración
// 2026110606). Ver services/projects/projectLabor.service.js.
// breakdown: { devengado, aportes, provisiones } del empleado en el periodo.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectLaborAllocation = sequelize.define('ProjectLaborAllocation', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  payroll_period_id: { type: DataTypes.UUID, allowNull: false },
  employee_id: { type: DataTypes.UUID, allowNull: false },
  project_id: { type: DataTypes.UUID, allowNull: false },
  period_end: { type: DataTypes.DATEONLY, allowNull: false },
  hours: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
  base_hours: { type: DataTypes.DECIMAL(8, 2), allowNull: false },
  percentage: { type: DataTypes.DECIMAL(7, 4), allowNull: false },
  employee_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  breakdown: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'project_labor_allocations', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ProjectLaborAllocation;
