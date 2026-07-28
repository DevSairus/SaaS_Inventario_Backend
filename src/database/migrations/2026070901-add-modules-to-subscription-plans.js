'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('subscription_plans', { schema: 'public' });

    if (!existingColumns.modules) {
      await queryInterface.addColumn('subscription_plans', 'modules', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
        comment: 'Lista de slugs de módulos habilitados para este plan (ej: ["workshop","sales","inventory"])',
      }, { schema: 'public' });
    }

    if (!existingColumns.max_products) {
      await queryInterface.addColumn('subscription_plans', 'max_products', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 100,
        comment: 'Número máximo de productos activos. -1 = ilimitado',
      }, { schema: 'public' });
    }

    if (!existingColumns.max_warehouses) {
      await queryInterface.addColumn('subscription_plans', 'max_warehouses', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'Número máximo de bodegas activas. -1 = ilimitado',
      }, { schema: 'public' });
    }

    // ── Seed / actualización de los planes legacy que hoy viven hardcodeados
    //    en checkLimits.js, para no perder límites al migrar. Si el plan ya
    //    existe (por slug) se actualiza; si no existe, se crea.
    const ALL_MODULES = [
      'workshop', 'sales', 'inventory', 'cartera',
      'treasury', 'electronic_invoicing', 'reports',
    ];

    const legacyPlans = [
      { slug: 'free', name: 'Free', monthly_price: 0, yearly_price: 0,
        max_users: 2, max_clients: 50, max_products: 100, max_warehouses: 1, max_invoices_per_month: 10,
        modules: ['sales', 'inventory', 'reports'], sort_order: 1 },
      { slug: 'basic', name: 'Basic', monthly_price: 29000, yearly_price: 290000,
        max_users: 5, max_clients: 200, max_products: 500, max_warehouses: 2, max_invoices_per_month: 50,
        modules: ALL_MODULES, sort_order: 2 },
      { slug: 'starter', name: 'Starter', monthly_price: 29000, yearly_price: 290000,
        max_users: 5, max_clients: 200, max_products: 500, max_warehouses: 2, max_invoices_per_month: 50,
        modules: ALL_MODULES, sort_order: 2 },
      { slug: 'premium', name: 'Premium', monthly_price: 69000, yearly_price: 690000,
        max_users: 15, max_clients: 1000, max_products: 2000, max_warehouses: 5, max_invoices_per_month: 200,
        modules: ALL_MODULES, sort_order: 3 },
      { slug: 'professional', name: 'Professional', monthly_price: 69000, yearly_price: 690000,
        max_users: 15, max_clients: 1000, max_products: 2000, max_warehouses: 5, max_invoices_per_month: 200,
        modules: ALL_MODULES, sort_order: 3 },
      { slug: 'enterprise', name: 'Enterprise', monthly_price: 149000, yearly_price: 1490000,
        max_users: -1, max_clients: -1, max_products: -1, max_warehouses: -1, max_invoices_per_month: -1,
        modules: ALL_MODULES, sort_order: 4 },
    ];

    for (const p of legacyPlans) {
      const [existing] = await queryInterface.sequelize.query(
        `SELECT id FROM "public"."subscription_plans" WHERE slug = :slug LIMIT 1`,
        { replacements: { slug: p.slug }, type: queryInterface.sequelize.QueryTypes.SELECT }
      );

      if (existing) {
        await queryInterface.sequelize.query(
          `UPDATE "public"."subscription_plans"
           SET modules = :modules::jsonb,
               max_products = :max_products,
               max_warehouses = :max_warehouses
           WHERE id = :id`,
          {
            replacements: {
              id: existing.id,
              modules: JSON.stringify(p.modules),
              max_products: p.max_products,
              max_warehouses: p.max_warehouses,
            },
          }
        );
      } else {
        await queryInterface.sequelize.query(
          `INSERT INTO "public"."subscription_plans"
             (id, name, slug, monthly_price, yearly_price, features, modules,
              max_users, max_clients, max_products, max_warehouses, max_invoices_per_month,
              is_active, sort_order, trial_days, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :name, :slug, :monthly_price, :yearly_price, '{}'::jsonb, :modules::jsonb,
              :max_users, :max_clients, :max_products, :max_warehouses, :max_invoices_per_month,
              true, :sort_order, 14, NOW(), NOW())`,
          {
            replacements: {
              name: p.name,
              slug: p.slug,
              monthly_price: p.monthly_price,
              yearly_price: p.yearly_price,
              modules: JSON.stringify(p.modules),
              max_users: p.max_users,
              max_clients: p.max_clients,
              max_products: p.max_products,
              max_warehouses: p.max_warehouses,
              max_invoices_per_month: p.max_invoices_per_month,
              sort_order: p.sort_order,
            },
          }
        );
      }
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('subscription_plans', 'max_warehouses', { schema: 'public' });
    await queryInterface.removeColumn('subscription_plans', 'max_products', { schema: 'public' });
    await queryInterface.removeColumn('subscription_plans', 'modules', { schema: 'public' });
  },
};
