'use strict';

// purchase_bank_account (pago a proveedor por banco/transferencia) se agregó
// a DEFAULT_ACCOUNT_MAPPINGS junto con la feature de saldos iniciales (ver
// openingBalances.controller.js registerPayment). La cuenta 111005 (Bancos)
// ya existe en el plan de cuentas de todos los tenants desde el seed
// original — solo falta el account_mapping para los que ya pasaron por el
// seed antes de este cambio.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
      SELECT gen_random_uuid(), a.tenant_id, 'purchase_bank_account', a.id, NOW(), NOW()
      FROM chart_of_accounts a
      WHERE a.code = '111005'
        AND NOT EXISTS (
          SELECT 1 FROM account_mappings m
          WHERE m.tenant_id = a.tenant_id AND m.event_type = 'purchase_bank_account'
        );
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DELETE FROM account_mappings WHERE event_type = 'purchase_bank_account';
    `);
  },
};
