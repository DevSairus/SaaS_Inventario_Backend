'use strict';

// Parte del descuento global de la venta que corresponde a una devolución
// (services/sales/globalDiscount.service.js). total_amount = subtotal + tax
// - discount_amount: antes se devolvía el valor de las líneas sin descontar
// y se acreditaba más de lo que el cliente pagó.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_returns ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(15,2) NOT NULL DEFAULT 0`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE customer_returns DROP COLUMN IF EXISTS discount_amount`);
  },
};
