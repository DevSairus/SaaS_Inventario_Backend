'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // ── SUPPLIERS: falta 'name' (NOT NULL) y 'code' (nullable) ──────────
      // 'name' es NOT NULL en el modelo, pero puede haber proveedores ya
      // creados sin ese valor (la tabla nunca tuvo la columna). Por eso:
      // 1) se agrega nullable, 2) se rellena con el mejor dato disponible,
      // 3) recién ahí se aplica la restricción NOT NULL.
      await queryInterface.sequelize.query(
        `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS name VARCHAR(255)`,
        { transaction }
      );
      await queryInterface.sequelize.query(`
        UPDATE suppliers
        SET name = COALESCE(NULLIF(business_name, ''), NULLIF(trade_name, ''), 'Proveedor ' || tax_id, 'Proveedor sin nombre')
        WHERE name IS NULL
      `, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE suppliers ALTER COLUMN name SET NOT NULL`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS code VARCHAR(50)`,
        { transaction }
      );

      // ── PURCHASES: faltan 'expected_delivery_date' y 'reference' (ambas nullable) ──
      await queryInterface.sequelize.query(
        `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS expected_delivery_date DATE`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS reference VARCHAR(100)`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No se revierte: son columnas base que el modelo siempre asumió que existían.
    // Quitarlas rompería el código actual. Si de verdad se necesita, hacerlo manualmente.
  },
};
