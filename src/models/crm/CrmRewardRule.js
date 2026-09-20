// backend/src/models/crm/CrmRewardRule.js
//
// CRM — Gamificación, Fase 5. Ver gamificacion-crm-diseno.md §10.2. Regla
// configurable por tenant que traduce el cumplimiento de una CrmGoal en un
// incentivo (monetario o de reconocimiento). Mismo patrón tenant_id + CRUD
// que CrmGoal/CrmAutomationRule.
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmRewardRule = sequelize.define('CrmRewardRule', {
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
  name: {
    type: DataTypes.STRING(150),
    allowNull: false,
  },
  condition_type: {
    type: DataTypes.ENUM('meta_cumplida', 'racha', 'superacion'),
    allowNull: false,
    defaultValue: 'meta_cumplida',
  },
  condition_config: {
    // { min_periods } para racha, { min_percent } para superacion.
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
  tiers: {
    // Niveles apilables: [{ condition, reward_value }]. Ver
    // services/crmRewardService.js → resolveTier() para las condiciones
    // soportadas.
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  reward_type: {
    type: DataTypes.ENUM('monto_fijo', 'porcentaje_sobre_revenue_won', 'insignia', 'titulo'),
    allowNull: false,
    defaultValue: 'monto_fijo',
  },
  badge_config: {
    // { label, icon, color } — solo insignia/titulo.
    type: DataTypes.JSONB,
    allowNull: true,
  },
  auto_approve: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  bonus_salary_type: {
    type: DataTypes.ENUM('salarial', 'no_salarial'),
    allowNull: false,
    defaultValue: 'no_salarial',
  },
  distribution_mode: {
    type: DataTypes.ENUM('individual', 'equitativo', 'proporcional', 'monto_fijo_por_persona'),
    allowNull: false,
    defaultValue: 'individual',
  },
  payroll_concept_id: {
    // Concepto de nómina bajo el que se carga la bonificación. Nulo es
    // válido: PayrollNovedad.payroll_concept_id también lo es, y la novedad
    // se arma igual con dian_category 'Bonificaciones'.
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'payroll_concepts', key: 'id' },
    onDelete: 'SET NULL',
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
  tableName: 'crm_reward_rules',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'active'] },
    { fields: ['goal_id'] },
  ],
});

// true si la recompensa es dinero (y por lo tanto pasa por el flujo de
// aprobación/nómina de §10.4); false si es reconocimiento puro (§10.7).
CrmRewardRule.prototype.isMonetary = function isMonetary() {
  return this.reward_type === 'monto_fijo' || this.reward_type === 'porcentaje_sobre_revenue_won';
};

module.exports = CrmRewardRule;