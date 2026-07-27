'use strict';

// Prepara el modelo de bodegas para soportar múltiples bodegas por sede.
// Hoy `warehouses.branch_id` es UNIQUE (1 sede = 1 bodega). Esta migración:
//   1. Agrega `is_default` (bool) — la bodega que se usa automáticamente
//      para una sede cuando una OT/venta no especifica bodega.
//   2. Marca como default a la bodega actual de cada sede (hoy solo hay una
//      por sede, así que el backfill es 1:1 y no cambia el comportamiento
//      existente).
//   3. Reemplaza el UNIQUE(branch_id) por un índice único PARCIAL: solo
//      aplica sobre filas con is_default = true. Esto permite varias
//      bodegas por sede a futuro, garantizando siempre que como máximo una
//      de ellas esté marcada como default.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false`,
        { transaction }
      );

      // Backfill: la bodega que ya tiene sede asignada pasa a ser su default
      // (hoy es la única posible por el UNIQUE que estamos por retirar).
      await queryInterface.sequelize.query(
        `UPDATE warehouses SET is_default = true WHERE branch_id IS NOT NULL`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_branch_id_unique`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS warehouses_branch_default_unique
         ON warehouses (branch_id)
         WHERE is_default = true AND branch_id IS NOT NULL`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `DROP INDEX IF EXISTS warehouses_branch_default_unique`,
        { transaction }
      );

      // Nota: si para este punto ya existe más de una bodega activa por
      // sede, este UNIQUE fallará — es intencional, revertir esta
      // migración implica volver a 1 sede = 1 bodega.
      await queryInterface.sequelize.query(
        `ALTER TABLE warehouses ADD CONSTRAINT warehouses_branch_id_unique UNIQUE (branch_id)`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE warehouses DROP COLUMN IF EXISTS is_default`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
