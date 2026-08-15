'use strict';

// La cuenta 510510 (Comisiones a Técnicos) y su mapping
// (expense_category:comisiones_tecnicos) se agregaron a puc-colombia-standard.js
// para poder generar el asiento contable automático al liquidar una comisión
// (ver commissionSettlements.controller.js#create). El seed contable es
// idempotente y NO vuelve a correr para tenants que ya tienen plan de
// cuentas, así que esta migración hace el backfill puntual — igual patrón
// que 2026071502-seed-opening-balance-account-existing-tenants.js.

module.exports = {
  up: async (queryInterface) => {
    const [tenantsMissingAccount] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
      WHERE tenant_id NOT IN (SELECT tenant_id FROM chart_of_accounts WHERE code = '510510')
    `);

    for (const { tenant_id } of tenantsMissingAccount) {
      const [[parent51]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '51'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!parent51) continue; // tenant sin el grupo '51' -- plan de cuentas atípico, no forzar

      const [[account]] = await queryInterface.sequelize.query(
        `INSERT INTO chart_of_accounts
           (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :tenantId, '510510', 'Comisiones a Técnicos (Mano de Obra)', 'gasto', :parentId, 4, true, true, NOW(), NOW())
         RETURNING id`,
        { replacements: { tenantId: tenant_id, parentId: parent51.id } }
      );

      await queryInterface.sequelize.query(
        `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
         VALUES (gen_random_uuid(), :tenantId, 'expense_category:comisiones_tecnicos', :accountId, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        { replacements: { tenantId: tenant_id, accountId: account.id } }
      );
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type = 'expense_category:comisiones_tecnicos';
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM chart_of_accounts WHERE code = '510510';
    `);
  },
};
