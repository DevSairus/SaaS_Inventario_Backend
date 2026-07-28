'use strict';

// Sedes es el único recurso claramente monetizable (más sedes = más datos/
// soporte por tenant) que quedaba fuera del sistema de límites por plan
// (checkLimits.js ya lo hace para usuarios/clientes/productos/bodegas/
// facturas). Además del límite duro, se agrega un modo de sobrecargo
// opcional por plan: si allow_extra_branches es true, un tenant puede
// exceder max_branches y esas sedes de más quedan visibles para el
// superadmin como "facturables" a extra_branch_price c/u (sin generar
// ningún cobro/factura automático — eso no existe hoy en el sistema).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('subscription_plans', { schema: 'public' });

    if (!existingColumns.max_branches) {
      await queryInterface.addColumn('subscription_plans', 'max_branches', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'Número máximo de sedes activas. -1 = ilimitado',
      }, { schema: 'public' });
    }

    if (!existingColumns.allow_extra_branches) {
      await queryInterface.addColumn('subscription_plans', 'allow_extra_branches', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Si true, se puede exceder max_branches (sobrecargo facturable manualmente en vez de bloqueo)',
      }, { schema: 'public' });
    }

    if (!existingColumns.extra_branch_price) {
      await queryInterface.addColumn('subscription_plans', 'extra_branch_price', {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
        comment: 'Precio mensual sugerido por cada sede que exceda max_branches (solo si allow_extra_branches)',
      }, { schema: 'public' });
    }

    // Seed de los planes legacy (mismo criterio que 2026070901): free/basic/
    // starter quedan con el limite estricto de hoy (1 sede, sin sobrecargo);
    // premium/professional permiten sobrecargo; enterprise sigue ilimitado.
    const legacyBranchLimits = [
      { slug: 'free',         max_branches: 1, allow_extra_branches: false, extra_branch_price: 0 },
      { slug: 'basic',        max_branches: 1, allow_extra_branches: false, extra_branch_price: 0 },
      { slug: 'starter',      max_branches: 1, allow_extra_branches: false, extra_branch_price: 0 },
      { slug: 'premium',      max_branches: 2, allow_extra_branches: true,  extra_branch_price: 50000 },
      { slug: 'professional', max_branches: 2, allow_extra_branches: true,  extra_branch_price: 50000 },
      { slug: 'enterprise',   max_branches: -1, allow_extra_branches: false, extra_branch_price: 0 },
    ];

    for (const p of legacyBranchLimits) {
      await queryInterface.sequelize.query(
        `UPDATE "public"."subscription_plans"
         SET max_branches = :max_branches,
             allow_extra_branches = :allow_extra_branches,
             extra_branch_price = :extra_branch_price
         WHERE slug = :slug`,
        { replacements: p }
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('subscription_plans', 'extra_branch_price', { schema: 'public' });
    await queryInterface.removeColumn('subscription_plans', 'allow_extra_branches', { schema: 'public' });
    await queryInterface.removeColumn('subscription_plans', 'max_branches', { schema: 'public' });
  },
};
