'use strict';

// Gastos: INC (impoconsumo, no descontable -- p.ej. restaurante, telefonía
// móvil) y el tratamiento de IVA del gasto ('gravado' | 'exento' | 'excluido').
// total_amount = subtotal + tax_amount (IVA) + inc_amount. El INC queda en la
// cuenta del gasto (ver autoEntries.generateExpenseEntry). NULL en iva_status
// = gastos anteriores (0 % se trata como hasta ahora).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS expenses
        ADD COLUMN IF NOT EXISTS inc_rate DECIMAL(5, 2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS inc_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS iva_status VARCHAR(10)
    `);
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF to_regclass('expenses') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE c.conname = 'expenses_iva_status_check' AND t.oid = to_regclass('expenses')
        ) THEN
          ALTER TABLE expenses ADD CONSTRAINT expenses_iva_status_check
            CHECK (iva_status IS NULL OR iva_status IN ('gravado', 'exento', 'excluido'));
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS expenses DROP CONSTRAINT IF EXISTS expenses_iva_status_check`);
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS expenses DROP COLUMN IF EXISTS iva_status, DROP COLUMN IF EXISTS inc_amount, DROP COLUMN IF EXISTS inc_rate`);
  },
};
