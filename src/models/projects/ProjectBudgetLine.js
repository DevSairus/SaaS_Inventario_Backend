// backend/src/models/projects/ProjectBudgetLine.js
// Línea de presupuesto de un proyecto. La categoría define contra qué se
// compara en el estado de resultados (services/projects/projectPnl.service.js).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const BUDGET_CATEGORIES = ['materials', 'labor', 'services', 'other'];

const ProjectBudgetLine = sequelize.define('ProjectBudgetLine', {
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
  project_id: { type: DataTypes.UUID, allowNull: false },
  category: {
    type: DataTypes.STRING(20),
    allowNull: false,
    validate: { isIn: [BUDGET_CATEGORIES] },
  },
  description: { type: DataTypes.STRING(255), allowNull: false },
  product_id: { type: DataTypes.UUID, allowNull: true },
  quantity: { type: DataTypes.DECIMAL(15, 4), allowNull: true },
  unit_cost: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  budget_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false, defaultValue: 0 },
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
    validate: { isIn: [['manual', 'bom', 'quote']] },
  },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'project_budget_lines',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

ProjectBudgetLine.CATEGORIES = BUDGET_CATEGORIES;

module.exports = ProjectBudgetLine;
