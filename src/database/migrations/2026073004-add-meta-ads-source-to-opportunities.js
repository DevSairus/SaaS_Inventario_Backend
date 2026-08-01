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
        SELECT udt_name INTO udt
        FROM information_schema.columns
        WHERE table_name = 'opportunities' AND column_name = 'source';

        IF udt NOT IN ('varchar', 'text', 'bpchar') THEN
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'meta_ads'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'meta_ads');
          END IF;
        END IF;
      END $$;
    `);
  },

  down: async () => {
    // No-op -- ver nota de down en 2026071308-add-free-line-to-work-order-items.js
  },
};
