'use strict';

// CRM — Gamificación, Fase 1 (backend base). Ver
// gamificacion-crm-diseno.md §3 para el detalle de cada campo. Sigue el
// mismo patrón que 2026080301-create-crm-pipeline-stages.js y
// 2026080306-create-crm-automation-rules.js: tablas en `public` con
// `tenant_id`, sin cambiar el comportamiento del pipeline existente.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('crm_goals')) {
      await queryInterface.createTable('crm_goals', {
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
        goal_type: {
          type: Sequelize.ENUM('principal', 'secundaria'),
          allowNull: false,
          defaultValue: 'secundaria',
        },
        metric: {
          type: Sequelize.STRING(50),
          allowNull: false,
          comment: 'Clave del catálogo cerrado en código (utils/crmGoalMetrics.js)',
        },
        scope: {
          type: Sequelize.ENUM('individual', 'branch', 'tenant'),
          allowNull: false,
          defaultValue: 'individual',
        },
        target_value: {
          type: Sequelize.DECIMAL(15, 2),
          allowNull: false,
        },
        period_type: {
          type: Sequelize.ENUM('weekly', 'monthly', 'custom'),
          allowNull: false,
          defaultValue: 'monthly',
        },
        starts_at: {
          type: Sequelize.DATEONLY,
          allowNull: true,
          comment: 'Solo obligatorio si period_type = custom',
        },
        ends_at: {
          type: Sequelize.DATEONLY,
          allowNull: true,
          comment: 'Solo obligatorio si period_type = custom',
        },
        milestones: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
          comment: '[{ percent, message }] redactado por el admin',
        },
        icon_style: {
          type: Sequelize.STRING(50),
          allowNull: true,
        },
        active: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        created_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex('crm_goals', ['tenant_id', 'active'], {
        name: 'crm_goals_tenant_active_idx',
      });
      await queryInterface.addIndex('crm_goals', ['tenant_id', 'metric'], {
        name: 'crm_goals_tenant_metric_idx',
      });
    }

    if (!tables.includes('crm_goal_progress')) {
      await queryInterface.createTable('crm_goal_progress', {
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
        goal_id: {
          type: Sequelize.UUID,
          allowNull: false,
          // `crm_goals` es tabla de TENANT: NO se califica con schema, para que
          // dentro de un schema `tenant_*` la FK apunte a la crm_goals de ESE
          // schema y no a la de public (ver 2026091704-fix-crm-crossschema-fks.js).
          references: { model: 'crm_goals', key: 'id' },
          onDelete: 'CASCADE',
        },
        target_id: {
          type: Sequelize.UUID,
          allowNull: false,
          comment: 'user_id, branch_id o tenant_id según goal.scope (sin FK propia: cambia de tabla referenciada)',
        },
        period_start: {
          type: Sequelize.DATEONLY,
          allowNull: false,
        },
        period_end: {
          type: Sequelize.DATEONLY,
          allowNull: false,
        },
        current_value: {
          type: Sequelize.DECIMAL(15, 2),
          allowNull: false,
          defaultValue: 0,
        },
        percent: {
          type: Sequelize.DECIMAL(6, 2),
          allowNull: false,
          defaultValue: 0,
        },
        last_milestone_reached: {
          type: Sequelize.INTEGER,
          allowNull: true,
          comment: 'Índice del último milestone ya notificado (evita re-notificar)',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      await queryInterface.addIndex('crm_goal_progress', ['goal_id', 'target_id', 'period_start'], {
        name: 'crm_goal_progress_unique_period_uq', unique: true,
      });
      await queryInterface.addIndex('crm_goal_progress', ['tenant_id', 'target_id'], {
        name: 'crm_goal_progress_tenant_target_idx',
      });
    }

    if (!tables.includes('crm_gamification_settings')) {
      await queryInterface.createTable('crm_gamification_settings', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          unique: true,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        board_visibility: {
          type: Sequelize.ENUM('own_only', 'team', 'all'),
          allowNull: false,
          defaultValue: 'own_only',
        },
        enabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('crm_gamification_settings');
    await queryInterface.dropTable('crm_goal_progress');
    await queryInterface.dropTable('crm_goals');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_goals_goal_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_goals_scope";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_goals_period_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_gamification_settings_board_visibility";');
  },
};
