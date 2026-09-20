'use strict';

// Formato 1010 de Exógena (socios/accionistas/comuneros/cooperados) —
// Fase 4 del plan de Contabilidad Pitbox, Grupo C. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4: "no hay modelo de
// composición societaria del tenant; hay que crearlo desde cero".
//
// Es su propia tabla (no ExogenaManualRecord genérico) porque es un dato
// estructural que el tenant mantiene año a año -- vale la pena un CRUD
// propio con campos tipados en vez de JSONB, igual criterio que
// FixedAsset/Loan en fases anteriores.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS exogena_shareholders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,

        fiscal_year INTEGER NOT NULL CHECK (fiscal_year >= 2000),

        document_type VARCHAR(5) NOT NULL,
        tax_id VARCHAR(20) NOT NULL,

        -- Persona natural: first_name/last_name. Persona jurídica: business_name.
        first_name VARCHAR(60),
        last_name VARCHAR(60),
        business_name VARCHAR(450),

        address VARCHAR(200),
        city_code VARCHAR(5),
        country_code VARCHAR(4) NOT NULL DEFAULT '169',

        -- Valor nominal de la acción/aporte/derecho social a dic-31 (valnom).
        nominal_value DECIMAL(18,0) NOT NULL DEFAULT 0,
        -- Valor prima en colocación de acciones a dic-31 (valprm).
        premium_value DECIMAL(18,0) NOT NULL DEFAULT 0,
        -- Porcentaje de participación (0-100), hasta 6 decimales.
        participation_percentage DECIMAL(10,6) NOT NULL CHECK (participation_percentage >= 0 AND participation_percentage <= 100),

        created_by UUID REFERENCES "public"."users"(id),

        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);

    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS exogena_shareholders_tenant_year_idx ON exogena_shareholders (tenant_id, fiscal_year)`
    );
    // Llave única del formato: tipo doc + identificación del socio, por año.
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS exogena_shareholders_unique_key_idx ON exogena_shareholders (tenant_id, fiscal_year, document_type, tax_id)`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS exogena_shareholders`);
  },
};
