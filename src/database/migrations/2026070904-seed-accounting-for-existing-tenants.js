'use strict';

const { PUC_COLOMBIA_STANDARD, DEFAULT_ACCOUNT_MAPPINGS } = require('../../data/puc-colombia-standard');

module.exports = {
  up: async (queryInterface, Sequelize, context) => {
    // Bajo aprovisionamiento por-schema (context.tenantId presente), este
    // schema es de UN SOLO tenant -> filtrar, o quedaríamos sembrando el plan
    // de cuentas de TODOS los tenants del sistema dentro del schema de este.
    const [tenants] = context?.tenantId
      ? await queryInterface.sequelize.query(
          `SELECT id FROM "public"."tenants" WHERE id = :tenantId`,
          { replacements: { tenantId: context.tenantId } }
        )
      : await queryInterface.sequelize.query(`SELECT id FROM "public"."tenants"`);

    for (const tenant of tenants) {
      const [[{ count }]] = await queryInterface.sequelize.query(
        `SELECT COUNT(*)::int AS count FROM chart_of_accounts WHERE tenant_id = :tenantId`,
        { replacements: { tenantId: tenant.id } }
      );
      if (count > 0) continue; // ya tiene plan de cuentas (no debería, pero por seguridad)

      const codeToId = {};

      for (const acc of PUC_COLOMBIA_STANDARD) {
        const parent_id = acc.parent_code ? codeToId[acc.parent_code] || null : null;
        const level = acc.code.length <= 1 ? 1 : Math.ceil(acc.code.length / 2) + 1;

        const [[row]] = await queryInterface.sequelize.query(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, :code, :name, :type, :parent_id, :level, :accepts_entries, true, NOW(), NOW())
           RETURNING id`,
          {
            replacements: {
              tenantId: tenant.id,
              code: acc.code,
              name: acc.name,
              type: acc.type,
              parent_id,
              level,
              accepts_entries: acc.accepts_entries,
            },
          }
        );
        codeToId[acc.code] = row.id;
      }

      for (const [eventType, code] of Object.entries(DEFAULT_ACCOUNT_MAPPINGS)) {
        const account_id = codeToId[code];
        if (!account_id) continue;
        await queryInterface.sequelize.query(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :eventType, :accountId, NOW(), NOW())`,
          { replacements: { tenantId: tenant.id, eventType, accountId: account_id } }
        );
      }
    }
  },

  down: async (queryInterface) => {
    // No se revierte automáticamente: borrar el plan de cuentas de todos los
    // tenants es destructivo si ya se contabilizaron asientos sobre él.
    // Si de verdad se necesita revertir, hacerlo manualmente por tenant.
  },
};
