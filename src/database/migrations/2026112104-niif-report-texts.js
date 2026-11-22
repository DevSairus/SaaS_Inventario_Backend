'use strict';

// NIIF para Pymes — fase 5: notas a los estados financieros (sección 8).
//
//   niif_report_texts  texto propio del contador para una nota del año
//                      (note_key), que se agrega al texto automático
//                      (mode 'append') o lo reemplaza ('replace'). La clave
//                      '_firmas' guarda, en JSON, quiénes certifican los
//                      estados (art. 37 Ley 222 de 1995).

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS niif_report_texts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        year INTEGER NOT NULL,
        note_key VARCHAR(60) NOT NULL,
        mode VARCHAR(8) NOT NULL DEFAULT 'append' CHECK (mode IN ('append', 'replace')),
        body TEXT NOT NULL DEFAULT '',
        updated_by UUID,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, year, note_key)
      )
    `);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS niif_report_texts');
  },
};
