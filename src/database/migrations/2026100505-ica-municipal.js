'use strict';

// ICA por municipio (ver services/tax/ica.service.js).
//
// El ICA es un impuesto a cargo del contribuyente sobre sus ingresos brutos
// en cada municipio donde opera; no se le cobra al cliente en la factura.
//
//   ica_municipalities: municipios donde declara el tenant (periodicidad,
//     avisos y tableros, sobretasa bomberil, autorretención, cuentas de
//     ingreso que no son base gravable).
//   ica_activities: actividades CIIU de cada municipio con su tarifa (‰) y
//     los prefijos de cuentas de ingreso que les corresponden.
//   branches.ica_municipality_id: en qué municipio declara cada sede.
//   ica_settlements: causaciones contabilizadas (kind 'ica' = impuesto del
//     período con cruce de retenciones; 'autoica' = autorretención).

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      CREATE TABLE IF NOT EXISTS ica_municipalities (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        city_code VARCHAR(10),
        city_name VARCHAR(120) NOT NULL,
        periodicity VARCHAR(12) NOT NULL DEFAULT 'bimestral' CHECK (periodicity IN ('mensual', 'bimestral', 'anual')),
        avisos_tableros BOOLEAN NOT NULL DEFAULT false,
        avisos_pct DECIMAL(6,3) NOT NULL DEFAULT 15,
        bomberil_pct DECIMAL(6,3) NOT NULL DEFAULT 0,
        autoica_enabled BOOLEAN NOT NULL DEFAULT false,
        excluded_account_prefixes JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS ica_activities (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        municipality_id UUID NOT NULL REFERENCES ica_municipalities(id) ON DELETE CASCADE,
        ciiu_code VARCHAR(10),
        description VARCHAR(200) NOT NULL,
        rate DECIMAL(7,4) NOT NULL DEFAULT 0,
        autoica_rate DECIMAL(7,4),
        account_prefixes JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ica_activities_municipality_idx ON ica_activities (municipality_id)`);
    await q.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS ica_municipality_id UUID REFERENCES ica_municipalities(id) ON DELETE SET NULL`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS ica_settlements (
        id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        municipality_id UUID NOT NULL REFERENCES ica_municipalities(id) ON DELETE RESTRICT,
        kind VARCHAR(10) NOT NULL DEFAULT 'ica' CHECK (kind IN ('ica', 'autoica')),
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        base_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
        tax_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
        credits_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
        balance_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        entry_id UUID,
        status VARCHAR(12) NOT NULL DEFAULT 'causado' CHECK (status IN ('causado', 'anulado')),
        created_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        voided_by UUID,
        voided_at TIMESTAMPTZ,
        void_reason TEXT
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS ica_settlements_lookup_idx ON ica_settlements (tenant_id, municipality_id, kind, date_from)`);
    console.log('[Migration] ICA por municipio');
  },
  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`DROP TABLE IF EXISTS ica_settlements`);
    await q.query(`ALTER TABLE branches DROP COLUMN IF EXISTS ica_municipality_id`);
    await q.query(`DROP TABLE IF EXISTS ica_activities`);
    await q.query(`DROP TABLE IF EXISTS ica_municipalities`);
  },
};
