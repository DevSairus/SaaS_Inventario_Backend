'use strict';

// payroll_social_security_payable (cuenta nueva 237005) y payroll_net_payable
// (reutiliza 250505, ya sembrada desde el PUC original) se agregaron a
// DEFAULT_ACCOUNT_MAPPINGS junto con generatePayrollEntry -- antes esa
// función se importaba en payrollPeriodEmissionService.js/
// payrollTerminationService.js pero no existía en absoluto, así que la
// contabilización de nómina siempre fallaba. El seed contable es idempotente
// y no vuelve a correr para tenants que ya tienen plan de cuentas, así que
// esta migración hace el backfill puntual -- mismo patrón que
// 2026081401-backfill-comisiones-tecnicos-mapping.js.

module.exports = {
  up: async (queryInterface) => {
    // 1) Crear la cuenta 237005 para los tenants que no la tengan (bajo '23'
    // Cuentas por Pagar, mismo padre que 236505/236710/236805).
    const [tenantsMissingAccount] = await queryInterface.sequelize.query(`
      SELECT DISTINCT tenant_id FROM chart_of_accounts
      WHERE tenant_id NOT IN (SELECT tenant_id FROM chart_of_accounts WHERE code = '237005')
    `);

    for (const { tenant_id } of tenantsMissingAccount) {
      const [[parent23]] = await queryInterface.sequelize.query(
        `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '23'`,
        { replacements: { tenantId: tenant_id } }
      );
      if (!parent23) continue; // tenant sin el grupo '23' -- plan de cuentas atípico, no forzar

      await queryInterface.sequelize.query(
        `INSERT INTO chart_of_accounts
           (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :tenantId, '237005', 'Aportes de Seguridad Social por Pagar', 'pasivo', :parentId, 3, true, true, NOW(), NOW())`,
        { replacements: { tenantId: tenant_id, parentId: parent23.id } }
      );
    }

    // 2) account_mappings para ambas claves, apuntando a las cuentas por código.
    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'payroll_social_security_payable', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '237005'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'payroll_social_security_payable'
        );
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'payroll_net_payable', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '250505'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'payroll_net_payable'
        );
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type IN ('payroll_social_security_payable', 'payroll_net_payable');
    `);
    await queryInterface.sequelize.query(`
      DELETE FROM chart_of_accounts WHERE code = '237005';
    `);
  },
};
