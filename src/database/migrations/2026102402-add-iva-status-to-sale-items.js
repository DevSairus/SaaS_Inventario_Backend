'use strict';

// Tratamiento de IVA de cada línea de venta: 'gravado', 'exento' (tarifa 0 %,
// sí es IVA) o 'excluido' (no causa IVA). Viene del producto
// (products.tax_config.iva_status) al crear la línea y queda fijo en ella:
// la factura, las notas y el XML DIAN lo necesitan aunque el producto cambie
// después. Un excluido no lleva TaxTotal de IVA en la DIAN; antes todo lo de
// 0 % se enviaba como IVA 0 % (exento). NULL = líneas anteriores: se tratan
// como hasta ahora (0 % = exento).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS sale_items ADD COLUMN IF NOT EXISTS iva_status VARCHAR(10)
    `);
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF to_regclass('sale_items') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE c.conname = 'sale_items_iva_status_check' AND t.oid = to_regclass('sale_items')
        ) THEN
          ALTER TABLE sale_items ADD CONSTRAINT sale_items_iva_status_check
            CHECK (iva_status IS NULL OR iva_status IN ('gravado', 'exento', 'excluido'));
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS sale_items DROP CONSTRAINT IF EXISTS sale_items_iva_status_check`);
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS sale_items DROP COLUMN IF EXISTS iva_status`);
  },
};
