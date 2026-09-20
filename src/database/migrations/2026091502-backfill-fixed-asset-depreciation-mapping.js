'use strict';

// Los tenants NUEVOS reciben la cuenta 516005 (Depreciación) y sus 5
// mappings (fixed_asset_depreciation_expense:<categoria>) automáticamente
// vía seedChartOfAccountsForTenant (ver data/puc-colombia-standard.js). Para
// tenants EXISTENTES ese seed ya corrió antes de que Fase 1 (Activos Fijos)
// agregara estas cuentas al catálogo, así que hace falta backfill puntual
// -- mismo patrón que 2026082103-add-advance-account-mappings.js.
//
// Redundante a propósito con ensureFixedAssetDepreciationMappings()
// (services/accounting/accountingSeed.service.js), que corre automáticamente
// en cada arranque del servidor: esta migración da el backfill inmediato en
// el momento del deploy, sin depender de un restart o de correr el script
// de reconciliación a mano.

module.exports = {
  up: async (queryInterface) => {
    const [tenantsWithChartOfAccounts] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
    `);

    for (const { tenant_id } of tenantsWithChartOfAccounts) {
      // 51 — Operacionales de Administración (grupo, debería existir siempre
      // que haya plan de cuentas, pero por seguridad no se fuerza si no está)
      const [[parent51]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '51'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!parent51) continue; // plan de cuentas atípico, no forzar

      // 516005 — Depreciación (cuenta de detalle), crear si falta
      let [[account]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '516005'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!account) {
        [[account]] = await queryInterface.sequelize.query(
          `INSERT INTO chart_of_accounts
             (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           VALUES
             (gen_random_uuid(), :tenantId, '516005', 'Depreciación', 'gasto', :parentId, 4, true, true, NOW(), NOW())
           RETURNING id`,
          { replacements: { tenantId: tenant_id, parentId: parent51.id } }
        );
      }

      const categories = ['vehiculo', 'maquinaria', 'equipo_computo', 'muebles_enseres', 'otro'];
      for (const category of categories) {
        await queryInterface.sequelize.query(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :eventType, :accountId, NOW(), NOW())
           ON CONFLICT (tenant_id, event_type) DO NOTHING`,
          {
            replacements: {
              tenantId: tenant_id,
              eventType: `fixed_asset_depreciation_expense:${category}`,
              accountId: account.id,
            },
          }
        );
      }
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type LIKE 'fixed_asset_depreciation_expense:%';
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM chart_of_accounts WHERE code = '516005';
    `);
  },
};
