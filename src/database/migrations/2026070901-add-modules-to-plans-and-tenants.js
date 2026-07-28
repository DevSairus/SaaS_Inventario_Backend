'use strict';

// Sistema de módulos por plan:
// - subscription_plans gana `modules` (catálogo de módulos incluidos) y los
//   límites que le faltaban para reemplazar el objeto PLANS hardcodeado de
//   checkLimits.js (max_products, max_warehouses).
// - tenants gana `plan_id` (FK directa, independiente del estado de la
//   suscripción) + modules_enabled/modules_disabled para overrides puntuales.
// - Backfill: todos los tenants existentes quedan con acceso completo vía
//   modules_enabled para no perder funcionalidad el día del deploy.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE "public"."subscription_plans"
          ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS max_products INTEGER NOT NULL DEFAULT 100,
          ADD COLUMN IF NOT EXISTS max_warehouses INTEGER NOT NULL DEFAULT 1;
      `, { transaction });

      await queryInterface.sequelize.query(`
        ALTER TABLE "public"."tenants"
          ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES "public"."subscription_plans"(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS modules_enabled JSONB NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS modules_disabled JSONB NOT NULL DEFAULT '[]'::jsonb;
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS tenants_plan_id_idx ON "public"."tenants" (plan_id)`,
        { transaction }
      );

      // Backfill de seguridad: ningún tenant existente pierde acceso a nada
      // el día del deploy. Los módulos "reservados" (accounting, ai_assistant)
      // no se incluyen porque no existe funcionalidad detrás todavía.
      await queryInterface.sequelize.query(`
        UPDATE "public"."tenants"
        SET modules_enabled = '["workshop","sales","inventory","receivables","treasury"]'::jsonb
        WHERE modules_enabled = '[]'::jsonb;
      `, { transaction });

      // plan_id: se toma de la suscripción más reciente en estado trial/active,
      // si existe. Si no hay ninguna, queda NULL (moduleAccess lo tolera).
      await queryInterface.sequelize.query(`
        UPDATE "public"."tenants" t
        SET plan_id = sub.plan_id
        FROM (
          SELECT DISTINCT ON (tenant_id) tenant_id, plan_id
          FROM "public"."tenant_subscriptions"
          WHERE status IN ('trial', 'active')
          ORDER BY tenant_id, created_at DESC
        ) sub
        WHERE sub.tenant_id = t.id AND t.plan_id IS NULL;
      `, { transaction });

      // Módulos por defecto de los planes conocidos (free/basic/premium/enterprise).
      // Solo importa para tenants NUEVOS creados después del deploy — los
      // existentes ya quedaron cubiertos por el backfill de modules_enabled.
      const planModules = {
        free: ['sales', 'inventory'],
        basic: ['sales', 'inventory', 'workshop', 'receivables'],
        starter: ['sales', 'inventory', 'workshop', 'receivables'],
        premium: ['sales', 'inventory', 'workshop', 'receivables', 'treasury'],
        professional: ['sales', 'inventory', 'workshop', 'receivables', 'treasury'],
        enterprise: ['sales', 'inventory', 'workshop', 'receivables', 'treasury'],
      };

      for (const [slug, modules] of Object.entries(planModules)) {
        await queryInterface.sequelize.query(`
          UPDATE "public"."subscription_plans"
          SET modules = :modules::jsonb
          WHERE slug = :slug AND modules = '[]'::jsonb;
        `, {
          transaction,
          replacements: { slug, modules: JSON.stringify(modules) },
        });
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "public"."tenants"
        DROP COLUMN IF EXISTS plan_id,
        DROP COLUMN IF EXISTS modules_enabled,
        DROP COLUMN IF EXISTS modules_disabled;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE "public"."subscription_plans"
        DROP COLUMN IF EXISTS modules,
        DROP COLUMN IF EXISTS max_products,
        DROP COLUMN IF EXISTS max_warehouses;
    `);
  },
};
