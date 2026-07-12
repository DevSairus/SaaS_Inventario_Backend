'use strict';

// El seed contable (accountingSeed.service.js) es idempotente y NO vuelve a
// correr para tenants que ya tienen plan de cuentas — así que agregar las
// dos claves nuevas a DEFAULT_ACCOUNT_MAPPINGS (year_end_result,
// year_end_accumulated) no las crea automáticamente para tenants existentes.
// Esta migración hace ese backfill puntual: por cada tenant que ya tiene
// las cuentas 360505/370505 en su plan de cuentas (todos los que pasaron
// por el seed estándar), crea el account_mapping si todavía no existe.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'year_end_result', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '360505'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'year_end_result'
        );
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'year_end_accumulated', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '370505'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'year_end_accumulated'
        );
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type IN ('year_end_result', 'year_end_accumulated');
    `);
  },
};
