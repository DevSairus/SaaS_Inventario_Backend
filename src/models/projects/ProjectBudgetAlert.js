// backend/src/models/projects/ProjectBudgetAlert.js
// Alerta de sobrecosto de un proyecto (migración 2026110607).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const ProjectBudgetAlert = sequelize.define('ProjectBudgetAlert', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'tenants', key: 'id' } },
  project_id: { type: DataTypes.UUID, allowNull: false },
  category: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [['total', 'materials', 'labor', 'services', 'other']] } },
  level: { type: DataTypes.STRING(20), allowNull: false, validate: { isIn: [['warning', 'critical']] } },
  budget: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  executed: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
  executed_pct: { type: DataTypes.DECIMAL(7, 2), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open', validate: { isIn: [['open', 'resolved']] } },
  notified_at: { type: DataTypes.DATE, allowNull: true },
  resolved_at: { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'project_budget_alerts', timestamps: true, underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });

module.exports = ProjectBudgetAlert;
