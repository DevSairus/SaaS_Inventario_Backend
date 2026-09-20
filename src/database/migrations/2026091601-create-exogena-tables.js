'use strict';

// Información Exógena DIAN — Fase 4 del plan de Contabilidad Pitbox.
// Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4.
// Mismo patrón estructural que 2026091501-create-fixed-assets.js /
// 2026091503-create-loans.js: tablas compartidas (tenant_id -> public.tenants),
// no schema-per-tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Un registro por (tenant, formato) — checklist de los 13 formatos
      // seleccionables (ver DianExogenaFormats en data/exogena-catalogs.js
      // para el catálogo completo, incluyendo 1037/1034 que quedan
      // excluidos por decisión del usuario, ver plan Fase 4).
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS exogena_format_configs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,

          format_code VARCHAR(10) NOT NULL,
          is_enabled BOOLEAN NOT NULL DEFAULT false,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Mapeo de "concepto" DIAN (cpt) para los formatos que sí lo exigen
      // por registro (1001, 1007). A propósito NO se hardcodea ningún
      // código de concepto: la clasificación fiscal de cada naturaleza de
      // pago/ingreso la define el contador del tenant (con la cartilla de
      // Exógena vigente a la mano), este mapeo solo la persiste para no
      // tener que repetirla cada año. source_key agrupa por la naturaleza
      // disponible en los datos de Pitbox (ver exogena/thirdPartyMapper.js):
      // 'purchase' (compra de bienes), 'expense:<category>", "sale".
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS exogena_concept_mappings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,

          format_code VARCHAR(10) NOT NULL,
          source_key VARCHAR(60) NOT NULL,
          concept_code VARCHAR(10) NOT NULL,

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      // Registros de captura 100% manual para formatos donde Pitbox no
      // tiene (ni puede derivar) la data operativa -- hoy solo el 1004
      // (descuentos tributarios solicitados, ver plan Fase 4 Grupo A: "a
      // confirmar si Pitbox registra esto en algún lado hoy; probablemente
      // no"). payload guarda los atributos propios del formato (todo menos
      // la identidad del tercero, que vive en columnas propias para poder
      // validarla con exogenaReadiness).
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS exogena_manual_records (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,

          format_code VARCHAR(10) NOT NULL,
          fiscal_year INTEGER NOT NULL CHECK (fiscal_year >= 2000),

          third_party_document_type VARCHAR(5) NOT NULL,
          third_party_tax_id VARCHAR(20) NOT NULL,

          payload JSONB NOT NULL DEFAULT '{}',

          created_by UUID REFERENCES "public"."users"(id),

          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS exogena_format_configs_tenant_format_idx ON exogena_format_configs (tenant_id, format_code)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS exogena_concept_mappings_tenant_idx ON exogena_concept_mappings (tenant_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS exogena_concept_mappings_tenant_format_source_idx ON exogena_concept_mappings (tenant_id, format_code, source_key)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS exogena_manual_records_tenant_format_year_idx ON exogena_manual_records (tenant_id, format_code, fiscal_year)`,
        { transaction }
      );
      // Llave única del formato (ver anexos técnicos DIAN): tipo doc +
      // identificación no se repite por año/formato.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS exogena_manual_records_unique_key_idx ON exogena_manual_records (tenant_id, format_code, fiscal_year, third_party_document_type, third_party_tax_id)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS exogena_manual_records`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS exogena_concept_mappings`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS exogena_format_configs`);
  },
};
