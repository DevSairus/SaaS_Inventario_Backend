'use strict';

// Mismo patrón nullable-FK que ya usa el resto del código
// (Receipt.cash_session_id, CustomerAdvance.cash_session_id, etc.) — no una
// tabla polimórfica nueva. `sale_id` sigue existiendo para factura/NC/ND;
// `purchase_id` es el equivalente para Documento Soporte y sus ajustes.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE dian_events
        ADD COLUMN IF NOT EXISTS purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS dian_events_purchase_id_idx ON dian_events (purchase_id)
    `);
    console.log('[Migration] dian_events.purchase_id agregada');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`DROP INDEX IF EXISTS dian_events_purchase_id_idx`);
    await q.query(`ALTER TABLE dian_events DROP COLUMN IF EXISTS purchase_id`);
  },
};
