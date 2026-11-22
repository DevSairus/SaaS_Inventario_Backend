'use strict';

// NIIF para Pymes — fase 3: mediciones de cierre (ver services/accounting/niifMeasurements.service.js).
//
//   niif_measurements  cada corrida contabilizada: deterioro de cartera
//                      (sección 11), valor neto realizable de inventarios
//                      (sección 13) o diferencia en cambio (sección 30), con
//                      sus parámetros, el detalle calculado y el asiento.
//
// Mapeos nuevos (solo si la cuenta existe en el plan del tenant).

const MAPPINGS = [
  ['receivable_impairment_allowance', '139905'],
  ['receivable_impairment_expense', '519910'],
  ['receivable_impairment_recovery', '425055'],
  ['inventory_nrv_allowance', '149905'],
  ['inventory_nrv_expense', '519920'],
  ['inventory_nrv_recovery', '425060'],
  ['fx_gain', '421020'],
  ['fx_loss', '530525'],
];

module.exports = {
  MAPPINGS,
  up: async (queryInterface, Sequelize, context) => {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    await q(`
      CREATE TABLE IF NOT EXISTS niif_measurements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        kind VARCHAR(30) NOT NULL CHECK (kind IN ('receivable_impairment', 'inventory_nrv', 'fx_remeasurement')),
        cutoff_date DATE NOT NULL,
        params JSONB NOT NULL DEFAULT '{}'::jsonb,
        detail JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
        previous_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
        adjustment DECIMAL(18, 2) NOT NULL DEFAULT 0,
        journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
        reversed_at TIMESTAMP WITH TIME ZONE,
        reversed_by UUID,
        created_by UUID,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS niif_measurements_tenant_kind ON niif_measurements (tenant_id, kind, cutoff_date DESC)`);

    const [tenants] = context?.tenantId
      ? await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts WHERE tenant_id = :tenantId`, { tenantId: context.tenantId })
      : await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);
    for (const { tenant_id } of tenants) {
      for (const [event, code] of MAPPINGS) {
        await q(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           SELECT gen_random_uuid(), :tenantId, :event, id, NOW(), NOW()
           FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code AND accepts_entries
           LIMIT 1
           ON CONFLICT (tenant_id, event_type) DO NOTHING`,
          { tenantId: tenant_id, event, code }
        );
      }
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS niif_measurements');
    await queryInterface.sequelize.query(`DELETE FROM account_mappings WHERE event_type IN (${MAPPINGS.map(([e]) => `'${e}'`).join(', ')})`);
  },
};
