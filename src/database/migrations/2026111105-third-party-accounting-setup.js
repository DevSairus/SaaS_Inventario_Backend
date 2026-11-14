'use strict';

// 3.2 — Aviso a contabilidad por alta de cliente/proveedor.
// accounting_setup_status: 'pending' (recién creado, el contador debe revisar su
// configuración contable/tributaria) | 'configured'. Los terceros existentes
// quedan 'configured' (DEFAULT): el aviso solo aplica a los que se creen desde ahora.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. IF EXISTS porque también corre en `public`.

const TABLES = ['customers', 'suppliers'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const t of TABLES) {
      await q(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS accounting_setup_status VARCHAR(12) NOT NULL DEFAULT 'configured'`);
      await q(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS accounting_setup_at TIMESTAMP WITH TIME ZONE`);
      await q(`ALTER TABLE IF EXISTS ${t} ADD COLUMN IF NOT EXISTS accounting_setup_by UUID`);
      await q(`
        DO $$ BEGIN
          IF to_regclass('${t}') IS NOT NULL THEN
            ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_accounting_setup_status_check;
            ALTER TABLE ${t} ADD CONSTRAINT ${t}_accounting_setup_status_check
              CHECK (accounting_setup_status IN ('pending', 'configured'));
            CREATE INDEX IF NOT EXISTS idx_${t}_accounting_pending ON ${t} (tenant_id) WHERE accounting_setup_status = 'pending';
          END IF;
        END $$;
      `);
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const t of TABLES) {
      await q(`DROP INDEX IF EXISTS idx_${t}_accounting_pending`);
      await q(`ALTER TABLE IF EXISTS ${t} DROP CONSTRAINT IF EXISTS ${t}_accounting_setup_status_check`);
      await q(`ALTER TABLE IF EXISTS ${t} DROP COLUMN IF EXISTS accounting_setup_by`);
      await q(`ALTER TABLE IF EXISTS ${t} DROP COLUMN IF EXISTS accounting_setup_at`);
      await q(`ALTER TABLE IF EXISTS ${t} DROP COLUMN IF EXISTS accounting_setup_status`);
    }
  },
};
