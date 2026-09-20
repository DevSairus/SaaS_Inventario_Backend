// backend/src/models/crm/CrmGoalProgress.js
//
// CRM — Gamificación, Fase 1. Ver gamificacion-crm-diseno.md §3.2. Mismo
// rol que `lifecycle_stage` en crmLifecycleService.js: una caché que el
// motor en tiempo real (services/crmGamificationService.js) escribe en
// cada evento, para no recalcular desde cero en cada render del widget.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmGoalProgress = sequelize.define('CrmGoalProgress', {
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
  goal_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'crm_goals', key: 'id' },
    onDelete: 'CASCADE',
  },
  target_id: {
    // user_id, branch_id o tenant_id según goal.scope. Sin FK propia
    // porque la tabla referenciada cambia según el scope de la meta.
    type: DataTypes.UUID,
    allowNull: false,
  },
  period_start: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  period_end: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  current_value: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
  },
  percent: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: false,
    defaultValue: 0,
  },
  last_milestone_reached: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'crm_goal_progress',
  timestamps: true,
  underscored: true,

  indexes: [
    { unique: true, fields: ['goal_id', 'target_id', 'period_start'] },
    { fields: ['tenant_id', 'target_id'] },
  ],
});

module.exports = CrmGoalProgress;
