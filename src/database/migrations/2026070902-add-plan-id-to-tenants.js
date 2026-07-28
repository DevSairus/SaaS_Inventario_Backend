'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('tenants');

    if (!existingColumns.plan_id) {
      await queryInterface.addColumn('tenants', 'plan_id', {
        type: Sequelize.UUID,
        allowNull: true, // se backfillea abajo; se deja nullable por seguridad
        references: {
          model: { tableName: 'subscription_plans', schema: 'public' },
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Fuente de verdad del plan efectivo del tenant (independiente del estado de tenant_subscriptions)',
      });
    }

    if (!existingColumns.modules_enabled) {
      await queryInterface.addColumn('tenants', 'modules_enabled', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Módulos habilitados manualmente para este tenant además de los de su plan (override puntual)',
      });
    }

    if (!existingColumns.modules_disabled) {
      await queryInterface.addColumn('tenants', 'modules_disabled', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Módulos del plan bloqueados manualmente para este tenant (override puntual)',
      });
    }

    const existingIndexes = await queryInterface.showIndex('tenants');
    if (!existingIndexes.some(i => i.name === 'tenants_plan_id_idx' || (i.fields || []).some(f => f.attribute === 'plan_id'))) {
      await queryInterface.addIndex('tenants', ['plan_id']);
    }

    // ── Backfill ──────────────────────────────────────────────────────
    // 1) Tomar el plan desde la suscripción más reciente (tenant_subscriptions),
    //    que es la fuente real hoy usada por el flujo de superadmin.
    await queryInterface.sequelize.query(`
      UPDATE tenants t
      SET plan_id = sub.plan_id
      FROM (
        SELECT DISTINCT ON (tenant_id) tenant_id, plan_id
        FROM tenant_subscriptions
        ORDER BY tenant_id, created_at DESC
      ) sub
      WHERE sub.tenant_id = t.id
        AND t.plan_id IS NULL
    `);

    // 2) Para los que no tengan suscripción registrada, matchear por el
    //    string legacy tenants.plan contra subscription_plans.slug.
    await queryInterface.sequelize.query(`
      UPDATE tenants t
      SET plan_id = sp.id
      FROM subscription_plans sp
      WHERE t.plan_id IS NULL
        AND sp.slug = t.plan
    `);

    // 3) Cualquier tenant que siga sin plan_id (plan string no reconocido o
    //    vacío) cae al plan 'enterprise' -- mismo comportamiento de fallback
    //    "ilimitado" que ya tenía checkLimits.js para planes desconocidos,
    //    para no bloquear a nadie por accidente en la migración.
    await queryInterface.sequelize.query(`
      UPDATE tenants t
      SET plan_id = sp.id
      FROM subscription_plans sp
      WHERE t.plan_id IS NULL
        AND sp.slug = 'enterprise'
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('tenants', ['plan_id']);
    await queryInterface.removeColumn('tenants', 'modules_disabled');
    await queryInterface.removeColumn('tenants', 'modules_enabled');
    await queryInterface.removeColumn('tenants', 'plan_id');
  },
};
