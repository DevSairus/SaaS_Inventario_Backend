// backend/src/models/crm/CrmAutomationRuleLog.js
//
// CRM Fase C.1 — registro de disparos de reglas de sondeo (unattended_lead /
// stage_stale) por oportunidad. Sin esto, cada corrida del job volvería a
// crear la misma tarea mientras la oportunidad siga sin moverse: el log es
// lo que convierte "evaluar cada 30 min" en "avisar una sola vez por
// condición", no un spam de tareas duplicadas.
//
// No aplica a trigger_type='opportunity_created' (ese es un evento único,
// no hay nada que des-duplicar).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmAutomationRuleLog = sequelize.define('CrmAutomationRuleLog', {
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
  automation_rule_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'crm_automation_rules', key: 'id' },
    onDelete: 'CASCADE',
  },
  opportunity_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'opportunities', key: 'id' },
    onDelete: 'CASCADE',
  },
  // Guarda el stage_changed_at de la oportunidad al momento de disparar —
  // si la oportunidad cambia de etapa y vuelve a la misma más tarde, este
  // valor cambia y la regla puede volver a dispararse (condición "nueva").
  triggered_for_stage_changed_at: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  triggered_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'crm_automation_rule_logs',
  timestamps: false,
  underscored: true,

  indexes: [
    { unique: true, fields: ['automation_rule_id', 'opportunity_id', 'triggered_for_stage_changed_at'], name: 'crm_automation_rule_logs_dedupe_uq' },
  ],
});

module.exports = CrmAutomationRuleLog;
