'use strict';

// CRM — Gamificación, Fase 5 (recompensas). Ver gamificacion-crm-diseno.md
// §10. Dos tablas: la regla configurable (crm_reward_rules) y la recompensa
// ganada por una persona en un período (crm_rewards).
//
// OJO con los schemas (ver 2026091704-fix-crm-crossschema-fks.js): solo
// `tenants` y `users` se califican como `public`. `crm_goals`,
// `crm_reward_rules`, `payroll_concepts`, `payroll_novedades` y `employees`
// son tablas de TENANT — se referencian SIN schema para que dentro de un
// schema `tenant_*` la FK apunte a la tabla de ESE schema.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('crm_reward_rules')) {
      await queryInterface.createTable('crm_reward_rules', {
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
          references: { model: 'crm_goals', key: 'id' },
          onDelete: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING(150),
          allowNull: false,
        },
        condition_type: {
          type: Sequelize.ENUM('meta_cumplida', 'racha', 'superacion'),
          allowNull: false,
          defaultValue: 'meta_cumplida',
        },
        condition_config: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: {},
          comment: 'Parámetros de la condición: { min_periods } para racha, { min_percent } para superacion',
        },
        tiers: {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: [],
          comment: '[{ condition: "cumplida_1_periodo"|"racha_N_periodos"|"racha_N_o_mas"|"superacion_N", reward_value }]',
        },
        reward_type: {
          type: Sequelize.ENUM('monto_fijo', 'porcentaje_sobre_revenue_won', 'insignia', 'titulo'),
          allowNull: false,
          defaultValue: 'monto_fijo',
        },
        badge_config: {
          type: Sequelize.JSONB,
          allowNull: true,
          comment: '{ label, icon, color } — solo para insignia/titulo',
        },
        auto_approve: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        bonus_salary_type: {
          type: Sequelize.ENUM('salarial', 'no_salarial'),
          allowNull: false,
          defaultValue: 'no_salarial',
          comment: 'bonificacionS vs bonificacionNS en la novedad de nómina',
        },
        distribution_mode: {
          type: Sequelize.ENUM('individual', 'equitativo', 'proporcional', 'monto_fijo_por_persona'),
          allowNull: false,
          defaultValue: 'individual',
        },
        payroll_concept_id: {
          // No estaba en el diseño como campo: §10.4 hablaba de "concepto
          // creado una vez por el admin" sin decir dónde se guarda. Guardarlo
          // en la regla es lo único que permite crear la novedad sin pedirle
          // al admin que elija el concepto cada vez.
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'payroll_concepts', key: 'id' },
          onDelete: 'SET NULL',
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

      await queryInterface.addIndex('crm_reward_rules', ['tenant_id', 'active'], {
        name: 'crm_reward_rules_tenant_active_idx',
      });
      await queryInterface.addIndex('crm_reward_rules', ['goal_id'], {
        name: 'crm_reward_rules_goal_idx',
      });
    }

    if (!tables.includes('crm_rewards')) {
      await queryInterface.createTable('crm_rewards', {
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
          references: { model: 'crm_goals', key: 'id' },
          onDelete: 'CASCADE',
        },
        reward_rule_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'crm_reward_rules', key: 'id' },
          onDelete: 'CASCADE',
        },
        user_id: {
          // Siempre a nivel de persona, incluso cuando viene de una meta de
          // equipo (§10.8) — PayrollNovedad exige employee_id.
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        employee_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'employees', key: 'id' },
          onDelete: 'SET NULL',
          comment: 'Resultado del emparejamiento automático User↔Employee (§10.1)',
        },
        period_start: { type: Sequelize.DATEONLY, allowNull: false },
        period_end: { type: Sequelize.DATEONLY, allowNull: false },
        tier_applied: {
          type: Sequelize.STRING(50),
          allowNull: true,
        },
        amount: {
          type: Sequelize.DECIMAL(15, 2),
          allowNull: true,
          comment: 'Nulo si reward_type es insignia/titulo',
        },
        badge_config: {
          type: Sequelize.JSONB,
          allowNull: true,
          comment: 'Snapshot del badge_config de la regla al momento de otorgarse',
        },
        distribution_group_id: {
          type: Sequelize.UUID,
          allowNull: true,
          comment: 'Agrupa las filas de una misma meta de equipo repartida (§10.8)',
        },
        status: {
          type: Sequelize.ENUM(
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
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'payroll_novedades', key: 'id' },
          onDelete: 'SET NULL',
        },
        approved_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        approved_at: { type: Sequelize.DATE, allowNull: true },
        last_error: {
          type: Sequelize.TEXT,
          allowNull: true,
          comment: 'Último motivo por el que falló la carga a nómina, para la pantalla de consulta',
        },
        notes: { type: Sequelize.TEXT, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });

      // Una persona no puede ganar dos veces la misma regla en el mismo
      // período — es lo que hace idempotente al job nocturno.
      await queryInterface.addIndex('crm_rewards', ['reward_rule_id', 'user_id', 'period_start'], {
        name: 'crm_rewards_rule_user_period_uq', unique: true,
      });
      await queryInterface.addIndex('crm_rewards', ['tenant_id', 'status'], {
        name: 'crm_rewards_tenant_status_idx',
      });
      await queryInterface.addIndex('crm_rewards', ['tenant_id', 'user_id'], {
        name: 'crm_rewards_tenant_user_idx',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('crm_rewards');
    await queryInterface.dropTable('crm_reward_rules');
    const drops = [
      'enum_crm_rewards_status',
      'enum_crm_reward_rules_condition_type',
      'enum_crm_reward_rules_reward_type',
      'enum_crm_reward_rules_bonus_salary_type',
      'enum_crm_reward_rules_distribution_mode',
    ];
    for (const t of drops) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${t}";`);
    }
  },
};
