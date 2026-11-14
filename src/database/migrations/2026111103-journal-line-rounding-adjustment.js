'use strict';

// 5.1 — Ajuste al peso: marca las líneas de asiento que generó el sistema para
// cuadrar un descuadre por redondeo (bitácora de ajustes).
// Las cuentas 429581 / 529581 y sus mapeos NO se crean aquí: los siembra
// ensureAccountingSeeded (accountingSeed.service.js) al arrancar el servidor,
// para tenants nuevos y existentes.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. IF EXISTS porque también corre en `public`.

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS journal_entry_lines ADD COLUMN IF NOT EXISTS is_rounding_adjustment BOOLEAN NOT NULL DEFAULT FALSE`);
    await q(`
      DO $$ BEGIN
        IF to_regclass('journal_entry_lines') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_journal_lines_rounding_adjustment
            ON journal_entry_lines (entry_id) WHERE is_rounding_adjustment;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS idx_journal_lines_rounding_adjustment`);
    await q(`ALTER TABLE IF EXISTS journal_entry_lines DROP COLUMN IF EXISTS is_rounding_adjustment`);
  },
};
