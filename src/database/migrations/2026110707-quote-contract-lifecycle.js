'use strict';

// Ciclo de vida de la cotización que es contrato de un proyecto facturado por
// cortes de obra (ver services/projects/projectCuts.service.js):
//
//   contratada  → se facturó el primer corte; ya no es una cotización
//                 pendiente de convertir.
//   facturada   → los cortes completaron el 100 % del contrato.
//   cerrada     → se cerró a mano con saldo sin ejecutar (obra terminada antes,
//                 alcance reducido); no admite más cortes.
//
// sales.contract_*: quién/cuándo/por qué se cerró y el valor no ejecutado.
// Sin backfill: los cortes de obra salen en el mismo despliegue, así que no
// hay contratos facturados por cortes antes de esta migración.

const VALUES = ['contratada', 'facturada', 'cerrada'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    // ALTER TYPE ... ADD VALUE limitado a current_schema() (ver 2026110501).
    for (const value of VALUES) {
      // eslint-disable-next-line no-await-in-loop
      await q(`
        DO $$
        DECLARE
          udt_schema_name text;
          udt text;
        BEGIN
          SELECT udt_schema, udt_name INTO udt_schema_name, udt
          FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'sales' AND column_name = 'quote_status';
          IF udt IS NULL OR udt IN ('varchar', 'text', 'bpchar') THEN
            RETURN;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = udt_schema_name AND t.typname = udt AND e.enumlabel = '${value}'
          ) THEN
            EXECUTE format('ALTER TYPE %I.%I ADD VALUE %L', udt_schema_name, udt, '${value}');
          END IF;
        END $$;
      `);
    }

    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS contract_closed_at TIMESTAMP WITH TIME ZONE`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS contract_closed_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS contract_close_reason TEXT`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS contract_unexecuted_amount DECIMAL(15, 2)`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`UPDATE sales SET quote_status = 'aprobada' WHERE quote_status IN ('contratada', 'facturada', 'cerrada')`);
    for (const col of ['contract_closed_at', 'contract_closed_by', 'contract_close_reason', 'contract_unexecuted_amount']) {
      // eslint-disable-next-line no-await-in-loop
      await q(`ALTER TABLE sales DROP COLUMN IF EXISTS ${col}`);
    }
  },
};
