'use strict';

// Agrega 'meta_ads' a Opportunity.source -- los leads de Facebook/Instagram
// Lead Ads (ver metaWebhook.controller.js) hoy caerían en 'redes', pero
// distinguirlos permite medir conversión de pauta paga aparte de "redes
// sociales" genérico en el dashboard CRM (§8 del diseño). Mismo patrón
// defensivo que 2026071308-add-free-line-to-work-order-items.js.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        udt text;
      BEGIN
        -- table_schema = current_schema() es obligatorio: sin él, esta consulta
        -- matchea el "opportunities.source" de CUALQUIER schema visible (schema-
        -- per-tenant), así que en un tenant que todavía no tiene la tabla podía
        -- leer el udt_name de OTRO tenant y luego intentar "ALTER TYPE" sobre un
        -- tipo que no existe en el search_path de este tenant.
        SELECT udt_name INTO udt
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'opportunities' AND column_name = 'source';

        IF udt IS NOT NULL AND udt NOT IN ('varchar', 'text', 'bpchar') THEN
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = current_schema() AND t.typname = udt AND e.enumlabel = 'meta_ads'
          ) THEN
            EXECUTE format('ALTER TYPE %I.%I ADD VALUE %L', current_schema(), udt, 'meta_ads');
          END IF;
        END IF;
      END $$;
    `);
  },

  down: async () => {
    // No-op -- ver nota de down en 2026071308-add-free-line-to-work-order-items.js
  },
};
