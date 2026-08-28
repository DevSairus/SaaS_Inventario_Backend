'use strict';

// Agrega los valores 'support_document' y 'support_document_adjustment' al
// ENUM de dian_resolutions.document_type (hoy solo 'invoice' | 'credit_note'
// | 'debit_note'). Sigue el mismo patrón defensivo que
// 2026081502-add-parcial-to-sale-quote-status.js: detecta si la columna es
// ENUM nativo o VARCHAR+CHECK y maneja ambos casos.
//
// IMPORTANTE (ya vivido en el módulo de Anticipos): Postgres no permite usar
// un valor de ENUM recién agregado dentro de la MISMA transacción en la que
// se agregó. Por eso esto va en su propia migración, separada de cualquier
// otra que llegue a insertar/filtrar por 'support_document'.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        udt text;
      BEGIN
        SELECT udt_name INTO udt
        FROM information_schema.columns
        WHERE table_name = 'dian_resolutions' AND column_name = 'document_type';

        IF udt IS NULL THEN
          RETURN;
        ELSIF udt IN ('varchar', 'text', 'bpchar') THEN
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'dian_resolutions_document_type_check'
          ) THEN
            ALTER TABLE dian_resolutions DROP CONSTRAINT dian_resolutions_document_type_check;
          END IF;
          ALTER TABLE dian_resolutions
            ADD CONSTRAINT dian_resolutions_document_type_check
            CHECK (document_type IN ('invoice', 'credit_note', 'debit_note', 'support_document', 'support_document_adjustment'));
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'support_document'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'support_document');
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'support_document_adjustment'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'support_document_adjustment');
          END IF;
        END IF;
      END $$;
    `);
    console.log('[Migration] dian_resolutions_document_type: +support_document, +support_document_adjustment');
  },

  down: async () => {
    // No se revierte: quitar valores de ENUM con filas que ya los usan
    // requiere migrar esos datos primero — mismo criterio que el resto de
    // migraciones aditivas de este proyecto.
  },
};
