'use strict';

// La migración baseline (20260101000000-baseline-core-inventory-tables.js)
// define purchase_items con CREATE TABLE IF NOT EXISTS, que es un no-op en
// tenants cuya tabla ya existía de antes (la tabla "compartida original").
// Solo tenant_id/subtotal/total/updated_at (2026070611) e inc_rate/
// inc_amount/ica_rate/ica_amount (2026070302) recibieron su propio
// ADD COLUMN IF NOT EXISTS -- el resto de las columnas del baseline
// (product_name, product_sku, quantity, unit_cost, line_total, etc.) nunca
// lo tuvo, y por eso siguen faltando en esas tablas legadas (ver también
// 2026080601-add-line-number-to-purchase-items.js, mismo problema).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const addColumn = async (definition) => {
        await queryInterface.sequelize.query(
          `ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS ${definition}`,
          { transaction }
        );
      };

      await addColumn(`product_id UUID REFERENCES products(id) ON DELETE RESTRICT`);
      await addColumn(`product_name VARCHAR(255)`);
      await addColumn(`product_sku VARCHAR(100)`);
      await addColumn(`product_barcode VARCHAR(100)`);
      await addColumn(`quantity DECIMAL(15,4)`);
      await addColumn(`received_quantity DECIMAL(15,4) DEFAULT 0`);
      await addColumn(`unit_of_measure VARCHAR(20) DEFAULT 'unit'`);
      await addColumn(`unit_cost DECIMAL(15,4)`);
      await addColumn(`tax_rate DECIMAL(5,2) DEFAULT 0`);
      await addColumn(`tax_amount DECIMAL(15,2) DEFAULT 0`);
      await addColumn(`discount_percentage DECIMAL(5,2) DEFAULT 0`);
      await addColumn(`discount_amount DECIMAL(15,2) DEFAULT 0`);
      await addColumn(`line_total DECIMAL(15,2)`);
      await addColumn(`batch_number VARCHAR(100)`);
      await addColumn(`expiration_date DATE`);
      await addColumn(`notes TEXT`);
      await addColumn(`created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

      // Backfill de placeholders para filas legadas que quedaron sin estas
      // columnas -- son datos históricos de antes del corte por tenant, no
      // hay forma de recuperar los valores reales.
      await queryInterface.sequelize.query(`
        UPDATE purchase_items
        SET product_name = COALESCE(product_name, '(sin nombre)'),
            product_sku = COALESCE(product_sku, 'N/A'),
            quantity = COALESCE(quantity, 0),
            unit_of_measure = COALESCE(unit_of_measure, 'unit'),
            unit_cost = COALESCE(unit_cost, 0),
            line_total = COALESCE(line_total, total, 0)
        WHERE product_name IS NULL
           OR product_sku IS NULL
           OR quantity IS NULL
           OR unit_of_measure IS NULL
           OR unit_cost IS NULL
           OR line_total IS NULL
      `, { transaction });

      // NOT NULL solo en las columnas que el modelo (PurchaseItem.js) exige
      // con allowNull: false.
      const setNotNull = async (column) => {
        await queryInterface.sequelize.query(
          `ALTER TABLE purchase_items ALTER COLUMN "${column}" SET NOT NULL`,
          { transaction }
        );
      };
      await setNotNull('product_name');
      await setNotNull('product_sku');
      await setNotNull('quantity');
      await setNotNull('unit_of_measure');
      await setNotNull('unit_cost');
      await setNotNull('line_total');

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
