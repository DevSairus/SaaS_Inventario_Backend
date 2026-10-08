'use strict';

// Una línea libre de la venta (sale_items.item_type = 'free_line') no tiene
// producto de catálogo: anularla o devolverla reventaba con "product_id
// cannot be null" y la venta no se podía anular. La línea se sigue
// identificando por sale_item_id; sin producto no hay movimiento de
// inventario ni costo que reversar (destination = 'none').

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_return_items ALTER COLUMN product_id DROP NOT NULL`
    );
  },

  async down(queryInterface) {
    // Solo reversible si ya no quedan devoluciones de líneas libres.
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_return_items ALTER COLUMN product_id SET NOT NULL`
    );
  },
};
