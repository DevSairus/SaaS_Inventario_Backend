'use strict';

// Cotizaciones de venta ahora admiten aprobación por ítem (ver
// 2026081501-add-item-approval-to-sale-items.js): si el cliente aprueba
// algunos ítems y rechaza otros, el estado de la cotización queda 'parcial'
// -- mismo valor que ya usa WorkOrderQuoteRequest para el mismo caso en
// Taller. Mismo patrón defensivo que
// 2026071308-add-free-line-to-work-order-items.js: no hay certeza de si
// quote_status quedó como ENUM nativo de Postgres o VARCHAR+CHECK en todos
// los entornos, así que se maneja cualquiera de los dos casos.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        udt text;
      BEGIN
        SELECT udt_name INTO udt
        FROM information_schema.columns
        WHERE table_name = 'sales' AND column_name = 'quote_status';

        IF udt IS NULL THEN
          RETURN;
        ELSIF udt IN ('varchar', 'text', 'bpchar') THEN
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'sales_quote_status_check'
          ) THEN
            ALTER TABLE sales DROP CONSTRAINT sales_quote_status_check;
          END IF;
          ALTER TABLE sales
            ADD CONSTRAINT sales_quote_status_check
            CHECK (quote_status IN ('borrador', 'enviada', 'aprobada', 'parcial', 'rechazada', 'vencida'));
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'parcial'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'parcial');
          END IF;
        END IF;
      END $$;
    `);
  },

  down: async () => {
    // No se revierte: quitar un valor de ENUM/CHECK con filas existentes que
    // ya lo usan requiere migrar esos datos primero — mismo criterio que el
    // resto de migraciones "aditivas" de este proyecto (down es no-op).
  },
};
