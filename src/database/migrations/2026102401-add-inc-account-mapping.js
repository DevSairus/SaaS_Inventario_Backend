'use strict';

// INC (impoconsumo) de las ventas en su propia cuenta: 249505 "Impuesto
// Nacional al Consumo por Pagar" (bajo 24) con el mapeo sale_tax_inc. Hasta
// ahora generateSaleEntry y las notas/devoluciones acreditaban todo el
// impuesto -- INC incluido -- a sale_tax_iva (240805). Se agregó también a
// DEFAULT_ACCOUNT_MAPPINGS / PUC base para tenants nuevos; esto hace el
// backfill de los existentes (mismo patrón que
// 2026092102-backfill-payroll-account-mappings.js).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    const [[{ has_coa }]] = await queryInterface.sequelize.query(
      `SELECT to_regclass('chart_of_accounts') IS NOT NULL AND to_regclass('account_mappings') IS NOT NULL AS has_coa`
    );
    if (!has_coa) return;

    const [tenantsMissingAccount] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
      WHERE tenant_id NOT IN (SELECT tenant_id FROM chart_of_accounts WHERE code = '249505')
    `);

    for (const { tenant_id } of tenantsMissingAccount) {
      const [[parent24]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '24'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!parent24) continue; // plan de cuentas atípico sin el grupo 24: no forzar

      await queryInterface.sequelize.query(
        `INSERT INTO chart_of_accounts
           (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :tenantId, '249505', 'Impuesto Nacional al Consumo por Pagar', 'pasivo', :parentId, 4, true, true, NOW(), NOW())`,
        { replacements: { tenantId: tenant_id, parentId: parent24.id } }
      );
    }

    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'sale_tax_inc', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '249505'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'sale_tax_inc'
        );
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DELETE FROM account_mappings WHERE event_type = 'sale_tax_inc'`);
    // La cuenta 249505 no se borra: puede tener movimientos.
  },
};
