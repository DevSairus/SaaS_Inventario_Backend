'use strict';

// 2026081502-add-parcial-to-sale-quote-status.js buscaba la columna en
// information_schema.columns y el valor en pg_enum SIN filtrar por schema.
// Dentro del schema de un tenant nuevo encontraba `public.sales` (que ya
// tenía 'parcial') y no hacía nada, así que todo tenant aprovisionado desde
// cero quedó con enum_sales_quote_status sin 'parcial'. Se detectó al
// comparar un schema clonado de la plantilla contra uno viejo.
//
// Misma lógica, pero limitada a current_schema() (public o el tenant).
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        udt_schema_name text;
        udt text;
      BEGIN
        SELECT udt_schema, udt_name INTO udt_schema_name, udt
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sales' AND column_name = 'quote_status';

        IF udt IS NULL OR udt IN ('varchar', 'text', 'bpchar') THEN
          RETURN; -- sin columna, o VARCHAR+CHECK (ese caso sí lo cubría la migración original)
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = udt_schema_name AND t.typname = udt AND e.enumlabel = 'parcial'
        ) THEN
          -- Al final, como quedó en los schemas donde la original sí funcionó.
          EXECUTE format('ALTER TYPE %I.%I ADD VALUE %L', udt_schema_name, udt, 'parcial');
        END IF;
      END $$;
    `);
  },

  down: async () => {},
};
