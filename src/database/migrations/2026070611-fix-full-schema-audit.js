'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // ── commission_settlement_items ──────────────────────────────────
      await queryInterface.sequelize.query(
        `ALTER TABLE commission_settlement_items ADD COLUMN IF NOT EXISTS sale_id UUID`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE commission_settlement_items ADD COLUMN IF NOT EXISTS sale_number VARCHAR(50)`,
        { transaction }
      );

      // ── customer_returns ──────────────────────────────────────────────
      await queryInterface.sequelize.query(
        `ALTER TABLE customer_returns ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE customer_returns ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP WITH TIME ZONE`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE customer_returns ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
        { transaction }
      );

      // ── purchase_items ────────────────────────────────────────────────
      await queryInterface.sequelize.query(
        `ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS subtotal DECIMAL(15,2) DEFAULT 0`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS total DECIMAL(15,2) DEFAULT 0`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`,
        { transaction }
      );
      // Backfill razonable: si ya había filas sin subtotal/total, calcularlos
      // a partir de columnas que sí existían, en vez de dejarlos en 0.
      await queryInterface.sequelize.query(`
        UPDATE purchase_items
        SET subtotal = COALESCE(quantity * unit_cost - COALESCE(discount_amount, 0), 0)
        WHERE subtotal = 0
      `, { transaction });
      await queryInterface.sequelize.query(`
        UPDATE purchase_items
        SET total = COALESCE(subtotal + COALESCE(tax_amount, 0), 0)
        WHERE total = 0
      `, { transaction });

      // ── work_orders ───────────────────────────────────────────────────
      await queryInterface.sequelize.query(
        `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS product_settlement_id UUID`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No se revierte: son columnas base que el código ya asume que existen.
  },
};
