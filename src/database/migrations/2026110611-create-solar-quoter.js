'use strict';

// Cotizador solar (Fase 3 del módulo Proyectos). Ver services/solar/*.
//
//   solar_settings: parámetros del cotizador por empresa (precio base por
//     kWp y % de mano de obra, material eléctrico y consultoría; panel e
//     inversor por defecto del catálogo; eficiencia; AIU; condiciones; llave
//     de OCR.space).
//   solar_studies: cada estudio (consumo, ubicación y radiación, sistema,
//     resultado y precios) con su cotización (sales) y proyecto.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS solar_settings (
          tenant_id UUID PRIMARY KEY REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          price_per_kwp DECIMAL(15, 2) NOT NULL DEFAULT 1250000,
          labor_pct DECIMAL(5, 2) NOT NULL DEFAULT 22,
          electrical_pct DECIMAL(5, 2) NOT NULL DEFAULT 13,
          consulting_pct DECIMAL(5, 2) NOT NULL DEFAULT 10,
          service_tax_pct DECIMAL(5, 2) NOT NULL DEFAULT 19,
          performance_ratio DECIMAL(4, 3) NOT NULL DEFAULT 0.800,
          default_hsp DECIMAL(5, 2) NOT NULL DEFAULT 4.5,
          dc_ac_ratio DECIMAL(4, 2) NOT NULL DEFAULT 1.20,
          panel_product_id UUID REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
          panel_watts INTEGER NOT NULL DEFAULT 645,
          inverter_product_id UUID REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
          use_aiu BOOLEAN NOT NULL DEFAULT FALSE,
          aiu_admin_pct DECIMAL(5, 2) NOT NULL DEFAULT 10,
          aiu_unforeseen_pct DECIMAL(5, 2) NOT NULL DEFAULT 5,
          aiu_profit_pct DECIMAL(5, 2) NOT NULL DEFAULT 10,
          validity_days INTEGER NOT NULL DEFAULT 30,
          payment_terms JSONB NOT NULL DEFAULT '[{"pct":50,"label":"Anticipo al inicio"},{"pct":20,"label":"Llegada de equipos"},{"pct":20,"label":"Fin de la instalación"},{"pct":10,"label":"Inyección a la red"}]'::jsonb,
          conditions TEXT,
          ocr_api_key VARCHAR(200),
          updated_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);

      await q(`
        CREATE TABLE IF NOT EXISTS solar_studies (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          number VARCHAR(30) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'quoted', 'project')),
          customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          title VARCHAR(200),
          system_type VARCHAR(20) NOT NULL DEFAULT 'ongrid' CHECK (system_type IN ('ongrid', 'offgrid', 'hybrid')),
          city VARCHAR(120),
          department VARCHAR(120),
          address VARCHAR(255),
          latitude DECIMAL(9, 6),
          longitude DECIMAL(9, 6),
          hsp DECIMAL(5, 2),
          hsp_monthly JSONB,
          hsp_source VARCHAR(20),
          monthly_kwh DECIMAL(12, 2),
          tariff_kwh DECIMAL(10, 2),
          bill_data JSONB,
          inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
          results JSONB NOT NULL DEFAULT '{}'::jsonb,
          kwp DECIMAL(10, 3),
          total_amount DECIMAL(15, 2),
          quote_id UUID REFERENCES sales(id) ON DELETE SET NULL ON UPDATE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE,
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS solar_studies_tenant_number_uq ON solar_studies (tenant_id, number)`);
      await q(`CREATE INDEX IF NOT EXISTS solar_studies_tenant_created_idx ON solar_studies (tenant_id, created_at DESC)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS solar_studies`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS solar_settings`);
  },
};
