// backend/src/models/crm/CrmReward.js
//
// CRM — Gamificación, Fase 5. Ver gamificacion-crm-diseno.md §10.3. Una
// recompensa ganada por UNA persona en UN período, incluso cuando nace de
// una meta de sede/tenant (§10.8: el reparto genera varias filas agrupadas
// por distribution_group_id).
//
// No existe estado "pagada": se deriva del PayrollPeriod vinculado a la
// novedad (§10.4, punto 4), para que no pueda desincronizarse de la nómina
// real. Ver controllers/crm/rewards.controller.js → attachPaidFlag().
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmReward = sequelize.define('CrmReward', {
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
  reward_rule_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'crm_reward_rules', key: 'id' },
    onDelete: 'CASCADE',
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
    onDelete: 'CASCADE',
  },
  employee_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'employees', key: 'id' },
    onDelete: 'SET NULL',
  },
  period_start: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  period_end: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  tier_applied: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
  },
  badge_config: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  distribution_group_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM(
      'pendiente_aprobacion',
      'aprobada',
      'sin_empleado_vinculado',
      'aprobada_pendiente_nomina',
      'cargada_nomina',
      'otorgada'
    ),
    allowNull: false,
    defaultValue: 'pendiente_aprobacion',
  },
  payroll_novedad_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'payroll_novedades', key: 'id' },
    onDelete: 'SET NULL',
  },
  approved_by_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  approved_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  last_error: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'crm_rewards',
  timestamps: true,
  underscored: true,

  indexes: [
    { unique: true, fields: ['reward_rule_id', 'user_id', 'period_start'] },
    { fields: ['tenant_id', 'status'] },
    { fields: ['tenant_id', 'user_id'] },
  ],
});

module.exports = CrmReward;