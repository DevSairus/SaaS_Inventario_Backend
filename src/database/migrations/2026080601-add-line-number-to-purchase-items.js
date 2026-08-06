'use strict';

// purchase_items en tenants cuya tabla ya existía antes de la migración
// baseline (20260101000000-baseline-core-inventory-tables.js) nunca recibió
// la columna line_number: el CREATE TABLE IF NOT EXISTS de esa migración es
// un no-op quando la tabla ya existe, y ninguna migración posterior la
// agregó con ADD COLUMN IF NOT EXISTS (a diferencia de tenant_id/subtotal/
// total/updated_at, que sí lo hicieron).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS line_number INTEGER`,
        { transaction }
      );

      // Backfill: numerar los items existentes según su orden de creación
      // dentro de cada compra.
      await queryInterface.sequelize.query(`
        UPDATE purchase_items pi
        SET line_number = sub.rn
        FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY purchase_id ORDER BY created_at, id
          ) AS rn
          FROM purchase_items
        ) sub
        WHERE pi.id = sub.id
          AND pi.line_number IS NULL
      `, { transaction });

      await queryInterface.sequelize.query(
        `ALTER TABLE purchase_items ALTER COLUMN line_number SET NOT NULL`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No se revierte: es una columna base que el código ya asume que existe.
  },
};
