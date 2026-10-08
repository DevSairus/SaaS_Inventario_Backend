'use strict';

// Forma de pago de la venta (contado / crédito), decidida al volverse
// documento -- ver services/sales/paymentTerms.service.js. La usa el XML DIAN
// (PaymentMeans ID 1/2 + PaymentDueDate) y RADIAN (solo una factura a
// crédito es título valor). NULL en ventas anteriores: se infiere del saldo.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_form VARCHAR(10)`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE sales DROP COLUMN IF EXISTS payment_form`);
  },
};
