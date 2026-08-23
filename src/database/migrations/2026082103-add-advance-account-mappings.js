'use strict';

// Los tenants NUEVOS reciben la cuenta 280505 (Anticipos de Clientes) y su
// mapping automáticamente vía seedChartOfAccountsForTenant (ver
// data/puc-colombia-standard.js). Para tenants EXISTENTES ese seed ya corrió
// antes de que estas cuentas existieran en el catálogo, así que hace falta
// backfill puntual — mismo patrón que
// 2026081401-backfill-comisiones-tecnicos-mapping.js.

module.exports = {
  up: async (queryInterface) => {
    const [tenantsMissingAccount] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
      WHERE tenant_id NOT IN (SELECT tenant_id FROM chart_of_accounts WHERE code = '280505')
    `);

    for (const { tenant_id } of tenantsMissingAccount) {
      const [[parent2]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '2'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!parent2) continue; // tenant sin la clase '2' (Pasivo) -- plan de cuentas atípico, no forzar

      // 28 — Otros Pasivos (grupo, puede no existir todavía)
      let [[group28]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '28'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!group28) {
        [[group28]] = await queryInterface.sequelize.query(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, '28', 'Otros Pasivos', 'pasivo', :parentId, 2, false, true, NOW(), NOW())
           RETURNING id`,
          { replacements: { tenantId: tenant_id, parentId: parent2.id } }
        );
      }

      // 2805 — Anticipos y Avances Recibidos (subgrupo)
      let [[group2805]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '2805'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!group2805) {
        [[group2805]] = await queryInterface.sequelize.query(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, '2805', 'Anticipos y Avances Recibidos', 'pasivo', :parentId, 3, false, true, NOW(), NOW())
           RETURNING id`,
          { replacements: { tenantId: tenant_id, parentId: group28.id } }
        );
      }

      // 280505 — Anticipos de Clientes (cuenta de detalle)
      const [[account]] = await queryInterface.sequelize.query(
        `INSERT INTO chart_of_accounts
           (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :tenantId, '280505', 'Anticipos de Clientes', 'pasivo', :parentId, 4, true, true, NOW(), NOW())
         RETURNING id`,
        { replacements: { tenantId: tenant_id, parentId: group2805.id } }
      );

      await queryInterface.sequelize.query(
        `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
         VALUES (gen_random_uuid(), :tenantId, 'customer_advance_liability', :accountId, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        { replacements: { tenantId: tenant_id, accountId: account.id } }
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type = 'customer_advance_liability';
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM chart_of_accounts WHERE code IN ('280505', '2805', '28');
    `);
  },
};
