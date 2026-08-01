// backend/src/models/crm/CrmAutomationRule.js
//
// CRM Fase C.1 — motor de automatizaciones configurables. Generaliza el
// único automatismo que existía (recompra, hardcodeado en
// crmLifecycleService.js) a reglas "si esto → entonces esto" que cada
// tenant puede crear/editar/desactivar sin tocar código.
//
// trigger_type define qué evalúa la regla y quién la dispara:
//   - 'unattended_lead'  → oportunidad abierta sin movimiento de etapa hace
//                          N horas (ej. "lead sin contactar tras 2 horas").
//                          Evaluada por automationEngine.runPollingRules().
//   - 'stage_stale'      → oportunidad lleva N horas/días en una etapa
//                          específica sin moverse (ej. "3 días en
//                          cotizado"). Misma evaluación periódica.
//   - 'opportunity_created' → se dispara en el momento de crear la
//                          oportunidad (ej. "entra un lead de Meta Ads").
//                          Se invoca en línea desde
//                          opportunities.controller.js y metaWebhook.controller.js.
//
// trigger_config (JSON) — según trigger_type:
//   unattended_lead:    { hours, source? }            // source opcional filtra por canal
//   stage_stale:        { stage_key, hours }
//   opportunity_created: { source? }                  // source opcional filtra por canal
//
// action_type / action_config (JSON):
//   'create_task'        → { title, due_in_hours, assign_to: 'owner'|'creator' }
//   'assign_round_robin'  → {}  (usa vendedores activos del tenant/sede)
//
// Las reglas de sondeo (unattended_lead/stage_stale) usan CrmAutomationRuleLog
// para no re-disparar la misma acción sobre la misma oportunidad mientras
// las condiciones se sigan cumpliendo (ver services/crmAutomationEngine.js).
const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');

const CrmAutomationRule = sequelize.define('CrmAutomationRule', {
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
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
  trigger_type: {
    type: DataTypes.ENUM('unattended_lead', 'stage_stale', 'opportunity_created'),
    allowNull: false,
  },
  trigger_config: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
  action_type: {
    type: DataTypes.ENUM('create_task', 'assign_round_robin'),
    allowNull: false,
  },
  action_config: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
  created_by_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
  // Puntero de rotación para action_type='assign_round_robin' — el último
  // vendedor asignado, para saber a quién le toca la próxima vez. Vive acá
  // (no en action_config) porque es estado que la propia regla actualiza,
  // no configuración que el usuario edita a mano.
  last_round_robin_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
    onDelete: 'SET NULL',
  },
}, {
  tableName: 'crm_automation_rules',
  timestamps: true,
  underscored: true,

  indexes: [
    { fields: ['tenant_id', 'is_active'] },
    { fields: ['tenant_id', 'trigger_type'] },
  ],
});

module.exports = CrmAutomationRule;
