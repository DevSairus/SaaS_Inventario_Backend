'use strict';

// 6.1 — Flujograma de nómina: bitácora de cada período (quién avanzó de etapa,
// cuándo, y los intentos que las validaciones previas bloquearon).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. Se omite si no existe `payroll_periods` (schema public).

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$ BEGIN
        IF to_regclass('payroll_periods') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS payroll_period_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id UUID NOT NULL,
            payroll_period_id UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
            event_type VARCHAR(30) NOT NULL,
            from_status VARCHAR(20),
            to_status VARCHAR(20),
            user_id UUID,
            user_name VARCHAR(150),
            note TEXT,
            details JSONB,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS payroll_period_events_period_idx ON payroll_period_events (tenant_id, payroll_period_id, created_at);
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_period_events');
  },
};
