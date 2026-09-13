'use strict';

// Agrega 'payroll' y 'payroll_adjustment' al conjunto válido de
// dian_resolutions.document_type — mismo patrón defensivo que
// 2026082804-add-support-document-to-dian-resolutions-enum.js (la columna
// real en producción es VARCHAR+CHECK, no ENUM nativo, aunque el modelo
// Sequelize la declare como DataTypes.ENUM). 'payroll_adjustment' tiene 19
// caracteres — cabe sin problema en el VARCHAR(30) que ya dejó
// 2026082818-widen-dian-resolutions-document-type.js, no hace falta otra
// migración de ancho.
//
// La habilitación de Nómina Electrónica es un trámite DIAN independiente
// del de facturación (Plan-Implementacion-Nomina-Electronica-Nexora.md §2)
// — cada tenant que active el módulo de nómina va a necesitar su propia
// fila en dian_resolutions con document_type='payroll', is_test=true,
// diligenciada manualmente desde DianConfigPage cuando exista esa pantalla
// (Fase 3), igual que hoy se hace con 'support_document'.
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
            CHECK (document_type IN ('invoice', 'credit_note', 'debit_note', 'support_document', 'support_document_adjustment', 'payroll', 'payroll_adjustment'));
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'payroll'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'payroll');
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'payroll_adjustment'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'payroll_adjustment');
          END IF;
        END IF;
      END $$;
    `);
    console.log('[Migration] dian_resolutions_document_type: +payroll, +payroll_adjustment');
  },

  down: async () => {
    // No se revierte — mismo criterio que el resto de migraciones aditivas
    // de este proyecto (quitar valores de un CHECK/ENUM con filas que ya
    // los usan requiere migrar esos datos primero).
  },
};
