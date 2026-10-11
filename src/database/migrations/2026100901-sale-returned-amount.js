'use strict';

// Parte de la cartera de una venta que se canceló por devoluciones aprobadas
// (la porción no cobrada que generateCustomerReturnEntry acredita a
// sale_receivable). Saldo = total_amount - paid_amount - returned_amount.
// Antes aprobar una devolución no bajaba el saldo y Cuentas por Cobrar no
// cuadraba con la contabilidad.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS returned_amount DECIMAL(15,2) NOT NULL DEFAULT 0`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE sales DROP COLUMN IF EXISTS returned_amount`);
  },
};
