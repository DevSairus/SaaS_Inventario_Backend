// backend/src/models/crm/CrmGoal.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §3.1. Mismo
// patrón de tabla tenant_id + CRUD que CrmPipelineStage/CrmAutomationRule:
// cada tenant define sus propias metas, sin ENUM fijo de métrica (ver
// utils/crmGoalMetrics.js para el catálogo cerrado en código).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmGoal = sequelize.define('CrmGoal', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenant_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tenants', key: 'id' },
    onDelete: 'CASCADE',
  },
  name: {
    type: DataTypes.STRING(150),
    allowNull: false,
  },
  goal_type: {
    type: DataTypes.ENUM('principal', 'secundaria'),
    allowNull: false,
    defaultValue: 'secundaria',
  },
  metric: {
    // Clave del catálogo cerrado en utils/crmGoalMetrics.js
    // (opportunities_won, revenue_won, conversion_rate, followups_completed,
    // new_customers, no_leads_unattended, ...).
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  scope: {
    type: DataTypes.ENUM('individual', 'branch', 'tenant'),
    allowNull: false,
    defaultValue: 'individual',
  },
  target_value: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  period_type: {
    type: DataTypes.ENUM('weekly', 'monthly', 'custom'),
    allowNull: false,
    defaultValue: 'monthly',
  },
  starts_at: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  ends_at: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  milestones: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  icon_style: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  created_by_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
}, {
  tableName: 'crm_goals',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'active'] },
    { fields: ['tenant_id', 'metric'] },
  ],
});

module.exports = CrmGoal;
