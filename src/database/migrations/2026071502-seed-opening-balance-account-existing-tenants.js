'use strict';

// El seed contable (accountingSeed.service.js) es idempotente y NO vuelve a
// correr para tenants que ya tienen plan de cuentas — así que agregar la
// cuenta puente 38/380505 y su mapping (opening_balance_suspense) a
// puc-colombia-standard.js no las crea automáticamente para tenants que ya
// pasaron por el seed antes de este cambio. Esta migración hace ese backfill
// puntual, por cada tenant que ya tiene chart_of_accounts pero todavía no
// tiene la cuenta 380505.

module.exports = {
  up: async (queryInterface) => {
    const [tenantsMissingAccount] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
      WHERE tenant_id NOT IN (SELECT tenant_id FROM chart_of_accounts WHERE code = '380505')
    `);

    for (const { tenant_id } of tenantsMissingAccount) {
      // Grupo agrupador '38' — puede no existir todavía en tenants antiguos.
      const [[group]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '38'`,
        { replacements: { tenantId: tenant_id } }
      );

      let groupId = group?.id;
      if (!groupId) {
        const [[parent3]] = await queryInterface.sequelize.query(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '3'`,
          { replacements: { tenantId: tenant_id } }
        );
        const [[createdGroup]] = await queryInterface.sequelize.query(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, '38', 'Superávit de Capital', 'patrimonio', :parentId, 2, false, true, NOW(), NOW())
           RETURNING id`,
          { replacements: { tenantId: tenant_id, parentId: parent3?.id || null } }
        );
        groupId = createdGroup.id;
      }

      const [[account]] = await queryInterface.sequelize.query(
        `INSERT INTO chart_of_accounts
           (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :tenantId, '380505', 'Cuenta Puente — Saldos de Apertura', 'patrimonio', :groupId, 4, true, true, NOW(), NOW())
         RETURNING id`,
        { replacements: { tenantId: tenant_id, groupId } }
      );

      await queryInterface.sequelize.query(
        `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
         VALUES (gen_random_uuid(), :tenantId, 'opening_balance_suspense', :accountId, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        { replacements: { tenantId: tenant_id, accountId: account.id } }
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type = 'opening_balance_suspense';
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM chart_of_accounts WHERE code = '380505';
    `);
    // El grupo '38' se deja: podría haber sido creado independientemente por
    // el seed estándar en otro momento; borrarlo a ciegas es más riesgoso
    // que dejar un agrupador vacío sin cuentas de detalle.
  },
};
