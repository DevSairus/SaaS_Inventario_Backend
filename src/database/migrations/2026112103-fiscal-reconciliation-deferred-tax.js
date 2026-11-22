'use strict';

// NIIF para Pymes — fase 4: conciliación fiscal (formato 2516) e impuesto
// diferido (sección 29). Ver services/accounting/fiscalReconciliation.service.js.
//
//   fiscal_reconciliation_settings  parámetros fiscales del año: método de
//                                   provisión fiscal de cartera, tarifa de
//                                   renta, pérdidas fiscales por compensar,
//                                   si se reconoce el activo diferido.
//   fiscal_adjustments              ajustes manuales del contador, del lado
//                                   patrimonial (valor fiscal − contable de
//                                   un rubro/cuenta) o de renta líquida.
//   niif_measurements.kind          + 'deferred_tax'.

const MAPPINGS = [
  ['deferred_tax_asset', '171076'],
  ['deferred_tax_liability', '272505'],
  ['deferred_tax_expense', '540510'],
];

module.exports = {
  up: async (queryInterface, Sequelize, context) => {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });

    await q(`
      CREATE TABLE IF NOT EXISTS fiscal_reconciliation_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        year INTEGER NOT NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by UUID,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, year)
      )
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS fiscal_adjustments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        year INTEGER NOT NULL,
        statement VARCHAR(3) NOT NULL CHECK (statement IN ('esf', 'eri')),
        rubro VARCHAR(40),
        account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL,
        difference_type VARCHAR(12) NOT NULL CHECK (difference_type IN ('temporaria', 'permanente')),
        amount DECIMAL(18, 2) NOT NULL,
        description VARCHAR(300) NOT NULL,
        created_by UUID,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS fiscal_adjustments_tenant_year ON fiscal_adjustments (tenant_id, year)`);

    await q(`ALTER TABLE niif_measurements DROP CONSTRAINT IF EXISTS niif_measurements_kind_check`);
    await q(`ALTER TABLE niif_measurements ADD CONSTRAINT niif_measurements_kind_check
             CHECK (kind IN ('receivable_impairment', 'inventory_nrv', 'fx_remeasurement', 'deferred_tax'))`);

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
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS fiscal_adjustments');
    await q('DROP TABLE IF EXISTS fiscal_reconciliation_settings');
    await q(`DELETE FROM account_mappings WHERE event_type IN (${MAPPINGS.map(([e]) => `'${e}'`).join(', ')})`);
  },
};
