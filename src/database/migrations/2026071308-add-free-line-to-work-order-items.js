'use strict';

// Replica en work_order_items lo que ya existe en sale_items: permitir un
// tercer tipo de ítem 'free_line' (línea libre, ad-hoc, sin producto real de
// catálogo) además de 'repuesto'/'servicio'/'mano_obra'. Para eso:
//   1. product_id pasa a ser NULLABLE (hoy es NOT NULL en work_order_items).
//   2. item_type debe aceptar 'free_line' — se maneja de forma defensiva
//      porque no hay certeza de si la columna quedó como ENUM nativo de
//      Postgres (creada por sequelize.sync en algún entorno) o como
//      VARCHAR + CHECK constraint (patrón usado en el resto de migraciones
//      de este proyecto, ver 20260703-add-nota-credito-debito-to-document-type.js).

module.exports = {
  up: async (queryInterface) => {
    // product_id nullable — DROP NOT NULL es un no-op seguro si ya es nullable.
    await queryInterface.sequelize.query(`
      ALTER TABLE work_order_items ALTER COLUMN product_id DROP NOT NULL;
    `);

    // item_type: agregar 'free_line' sea ENUM nativo o VARCHAR+CHECK.
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        udt text;
      BEGIN
        SELECT udt_name INTO udt
        FROM information_schema.columns
        WHERE table_name = 'work_order_items' AND column_name = 'item_type';

        IF udt IN ('varchar', 'text', 'bpchar') THEN
          -- VARCHAR/TEXT + CHECK constraint
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'work_order_items_item_type_check'
          ) THEN
            ALTER TABLE work_order_items DROP CONSTRAINT work_order_items_item_type_check;
          END IF;
          ALTER TABLE work_order_items
            ADD CONSTRAINT work_order_items_item_type_check
            CHECK (item_type IN ('repuesto', 'servicio', 'mano_obra', 'free_line'));
        ELSE
          -- ENUM nativo de Postgres (udt_name = nombre del tipo, ej. enum_work_order_items_item_type)
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = udt AND e.enumlabel = 'free_line'
          ) THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE %L', udt, 'free_line');
          END IF;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    // No se revierte: quitar un valor de ENUM/CHECK con filas existentes que
    // ya lo usan requiere migrar esos datos primero — mismo criterio que el
    // resto de migraciones "aditivas" de este proyecto (down es no-op).
  },
};
