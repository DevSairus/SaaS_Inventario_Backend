// backend/src/models/projects/ProjectTimeEntry.js
// Horas de un empleado en un proyecto (migración 2026110606).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectTimeEntry = sequelize.define('ProjectTimeEntry', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  project_id: { type: DataTypes.UUID, allowNull: false },
  employee_id: { type: DataTypes.UUID, allowNull: false },
  work_date: { type: DataTypes.DATEONLY, allowNull: false },
  hours: { type: DataTypes.DECIMAL(5, 2), allowNull: false },
  notes: { type: DataTypes.STRING(255), allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, { tableName: 'project_time_entries', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ProjectTimeEntry;
