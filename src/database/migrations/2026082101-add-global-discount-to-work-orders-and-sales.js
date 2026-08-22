'use strict';

// Descuento global (no por ítem) para OT, ventas y cotizaciones (ventas y
// cotizaciones son la misma tabla `sales`, solo cambia document_type).
//
// work_orders ya tenía `discount_amount` pero sin forma de fijarlo desde la
// UI y sin soporte de porcentaje -- se agregan discount_type/discount_value
// y discount_amount pasa a ser siempre el monto ya resuelto (ver
// resolveDiscountAmount en workOrders.controller.js).
//
// sales NO tenía descuento global real: su `discount_amount` de cabecera es
// la SUMA de los descuentos por línea (sale_items.discount_amount), un
// campo distinto con semántica ya en uso (PDF, reportes). Para no romper
// esa cuenta se agrega una columna nueva `global_discount_amount` (+ type/
// value) en vez de reusar `discount_amount`.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // OJO: provisionTenantSchema.js corre esto con un pool de UNA sola
      // conexión (max: 1) -- toda query acá debe llevar { transaction}, y se
      // evita queryInterface.describeTable()/addColumn (ver la migración de
      // 2026082001 para el detalle del deadlock). ADD COLUMN IF NOT EXISTS
      // es idempotente igual.
      await queryInterface.sequelize.query(`
        ALTER TABLE work_orders
          ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) NOT NULL DEFAULT 'fixed',
          ADD COLUMN IF NOT EXISTS discount_value DECIMAL(15,2) NOT NULL DEFAULT 0;
      `, { transaction });

      // Backfill: cualquier OT que ya tuviera un discount_amount puesto
      // (el campo existía y era aceptado por update(), aunque sin UI) se
      // preserva como descuento fijo, para no perder ese valor.
      await queryInterface.sequelize.query(`
        UPDATE work_orders SET discount_value = discount_amount
        WHERE discount_amount > 0 AND discount_value = 0;
      `, { transaction });

      await queryInterface.sequelize.query(`
        ALTER TABLE sales
          ADD COLUMN IF NOT EXISTS global_discount_type VARCHAR(10) NOT NULL DEFAULT 'fixed',
          ADD COLUMN IF NOT EXISTS global_discount_value DECIMAL(15,2) NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS global_discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0;
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE work_orders
        DROP COLUMN IF EXISTS discount_type,
        DROP COLUMN IF EXISTS discount_value;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE sales
        DROP COLUMN IF EXISTS global_discount_type,
        DROP COLUMN IF EXISTS global_discount_value,
        DROP COLUMN IF EXISTS global_discount_amount;
    `);
  },
};
