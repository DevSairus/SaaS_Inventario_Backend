'use strict';

// Agrega los mapeos 'cash_session_surplus' y 'cash_session_shortage' a los
// tenants que YA tenían plan de cuentas contable (por lo tanto no fueron
// tocados por 2026070903/2026070904, que solo seedean tenants sin cuentas).
// Las cuentas 429505 (Ingresos Diversos) y 519599 (Gastos Diversos) ya
// existen en el PUC estándar de todos esos tenants — solo falta el mapeo.
const NEW_MAPPINGS = {
  cash_session_surplus: '429505',
  cash_session_shortage: '519599',
};

module.exports = {
  up: async (queryInterface) => {
    const [tenants] = await queryInterface.sequelize.query(`SELECT id FROM tenants`);

    for (const tenant of tenants) {
      for (const [eventType, code] of Object.entries(NEW_MAPPINGS)) {
        const [[account]] = await queryInterface.sequelize.query(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code LIMIT 1`,
          { replacements: { tenantId: tenant.id, code } }
        );
        if (!account) continue; // tenant sin plan de cuentas todavía (aún no usa contabilidad)

        await queryInterface.sequelize.query(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           VALUES (gen_random_uuid(), :tenantId, :eventType, :accountId, NOW(), NOW())
           ON CONFLICT (tenant_id, event_type) DO NOTHING`,
          { replacements: { tenantId: tenant.id, eventType, accountId: account.id } }
        );
      }
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `DELETE FROM account_mappings WHERE event_type IN ('cash_session_surplus', 'cash_session_shortage')`
    );
  },
};
