'use strict';

// Cuenta bancaria por la que se pagó un gasto: con ella el asiento acredita
// la subcuenta PUC propia de esa cuenta (bank_accounts.chart_of_account_id)
// en vez de la genérica expense_bank_account. Los abonos posteriores guardan
// su propio bank_account_id dentro de payment_history (igual que compras).

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL ON UPDATE CASCADE`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE expenses DROP COLUMN IF EXISTS bank_account_id`);
  },
};
