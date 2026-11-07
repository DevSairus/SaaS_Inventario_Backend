// backend/src/models/projects/Project.js
// Proyecto (obra): eje de costos del módulo Proyectos. Ver la migración
// 2026110502-create-projects.js y services/projects/*.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const PROJECT_TYPES = ['residencial', 'comercial', 'industrial', 'ongrid', 'offgrid', 'otro'];
const PROJECT_STATUSES = ['prospect', 'quoted', 'approved', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled'];

const Project = sequelize.define('Project', {
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
  branch_id: { type: DataTypes.UUID, allowNull: true },
  code: { type: DataTypes.STRING(30), allowNull: false },
  name: { type: DataTypes.STRING(200), allowNull: false },
  customer_id: { type: DataTypes.UUID, allowNull: true },
  quote_id: { type: DataTypes.UUID, allowNull: true },
  type: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'otro',
    validate: { isIn: [PROJECT_TYPES] },
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'prospect',
    validate: { isIn: [PROJECT_STATUSES] },
  },
  site_address: { type: DataTypes.TEXT, allowNull: true },
  city: { type: DataTypes.STRING(100), allowNull: true },
  capacity_kwp: { type: DataTypes.DECIMAL(12, 3), allowNull: true },
  start_date: { type: DataTypes.DATEONLY, allowNull: true },
  end_date_planned: { type: DataTypes.DATEONLY, allowNull: true },
  end_date_actual: { type: DataTypes.DATEONLY, allowNull: true },
  manager_id: { type: DataTypes.UUID, allowNull: true },
  warehouse_id: { type: DataTypes.UUID, allowNull: true },
  contract_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  // Umbrales de alerta de sobrecosto, % del presupuesto (migración 2026110607)
  alert_warning_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 80 },
  alert_critical_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 100 },
  // Retención de garantía de las facturas parciales, % antes de IVA (migración 2026110612)
  retention_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  retention_released_at: { type: DataTypes.DATE, allowNull: true },
  closed_at: { type: DataTypes.DATE, allowNull: true },
  closed_by: { type: DataTypes.UUID, allowNull: true },
  created_by: { type: DataTypes.UUID, allowNull: true },
}, {
  tableName: 'projects',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

Project.TYPES = PROJECT_TYPES;
Project.STATUSES = PROJECT_STATUSES;

module.exports = Project;
