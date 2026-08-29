'use strict';

// La migración 2026082804 agregó 'support_document'/'support_document_adjustment'
// al CHECK constraint de dian_resolutions.document_type para el caso en que
// la columna sea VARCHAR+CHECK (que es justo el caso en producción, no ENUM
// nativo) -- pero nunca amplió el LARGO de la columna, que quedó en
// VARCHAR(20) desde la migración baseline (20260102000000). 'invoice',
// 'credit_note' y 'debit_note' entran ahí, y 'support_document' (16
// caracteres) también por poco -- pero 'support_document_adjustment' (27
// caracteres) no, así que cualquier INSERT con ese valor revienta con
// "value too long for type character varying(20)" ANTES de llegar siquiera
// a evaluar el CHECK constraint que sí lo permite.
//
// Se amplía a VARCHAR(30) -- mismo largo que dian_events.document_type
// (baseline), con margen para cualquier valor futuro de esta familia. Si la
// columna ya es un ENUM nativo (rama que 2026082804 también contempla), esto
// es un no-op: los ENUM no tienen límite de caracteres por longitud.
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
          ALTER TABLE dian_resolutions ALTER COLUMN document_type TYPE VARCHAR(30);
        END IF;
      END $$;
    `);
    console.log('[Migration] dian_resolutions.document_type: VARCHAR(20) -> VARCHAR(30) (si aplica)');
  },

  down: async () => {
    // No se revierte: achicar la columna podría truncar filas que ya
    // usan 'support_document_adjustment' -- mismo criterio que el resto de
    // migraciones aditivas de este proyecto.
  },
};
