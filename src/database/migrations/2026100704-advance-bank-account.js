'use strict';

// Cuenta bancaria por la que se recibió un anticipo de cliente (no
// efectivo): el asiento de recepción debita su subcuenta PUC propia en vez
// de la genérica sale_bank_account. Las devoluciones guardan su propio
// bank_account_id dentro de refund_history.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_advances ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE customer_advances DROP COLUMN IF EXISTS bank_account_id`);
  },
};
