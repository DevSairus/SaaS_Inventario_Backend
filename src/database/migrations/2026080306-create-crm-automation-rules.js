'use strict';

// CRM Fase C.1 — motor de automatizaciones configurables. Generaliza
// runCrmLifecycleJob (que solo sabía disparar recompra) a reglas
// "si esto → entonces esto" definidas por tenant. Ver
// backend/src/models/crm/CrmAutomationRule.js para el detalle de
// trigger_type/action_type y backend/src/services/crmAutomationEngine.js
// para cómo se evalúan.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('crm_automation_rules')) {
      await queryInterface.createTable('crm_automation_rules', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING(150),
          allowNull: false,
        },
        is_active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        trigger_type: {
          type: Sequelize.ENUM('unattended_lead', 'stage_stale', 'opportunity_created'),
          allowNull: false,
        },
        trigger_config: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: {},
        },
        action_type: {
          type: Sequelize.ENUM('create_task', 'assign_round_robin'),
          allowNull: false,
        },
        action_config: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: {},
        },
        created_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        last_round_robin_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex('crm_automation_rules', ['tenant_id', 'is_active'], {
        name: 'crm_automation_rules_tenant_active_idx',
      });
      await queryInterface.addIndex('crm_automation_rules', ['tenant_id', 'trigger_type'], {
        name: 'crm_automation_rules_tenant_trigger_idx',
      });
    }

    if (!tables.includes('crm_automation_rule_logs')) {
      await queryInterface.createTable('crm_automation_rule_logs', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        automation_rule_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'crm_automation_rules', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        opportunity_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'opportunities', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        triggered_for_stage_changed_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        triggered_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.NOW,
        },
      });

      await queryInterface.addIndex('crm_automation_rule_logs', ['automation_rule_id', 'opportunity_id', 'triggered_for_stage_changed_at'], {
        name: 'crm_automation_rule_logs_dedupe_uq', unique: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('crm_automation_rule_logs');
    await queryInterface.dropTable('crm_automation_rules');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_automation_rules_trigger_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_automation_rules_action_type";');
  },
};
