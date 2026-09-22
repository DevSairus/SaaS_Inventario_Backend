'use strict';

// inventory_adjustment_surplus/shortage e internal_consumption_expense se
// agregaron a DEFAULT_ACCOUNT_MAPPINGS junto con generateAdjustmentEntry y
// generateInternalConsumptionEntry (autoEntries.service.js) -- las cuentas
// 429505 (Ingresos Diversos) y 519599 (Gastos Diversos) ya existen en el plan
// de cuentas de todos los tenants desde el seed original (las reutiliza
// cash_session_surplus/shortage), solo falta el account_mapping para los
// tenants que ya pasaron por el seed antes de este cambio.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'inventory_adjustment_surplus', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '429505'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'inventory_adjustment_surplus'
        );
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'inventory_adjustment_shortage', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '519599'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'inventory_adjustment_shortage'
        );
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'internal_consumption_expense', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '519599'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'internal_consumption_expense'
        );
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings
      WHERE event_type IN ('inventory_adjustment_surplus', 'inventory_adjustment_shortage', 'internal_consumption_expense');
    `);
  },
};
