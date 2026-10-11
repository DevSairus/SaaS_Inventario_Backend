'use strict';

// Qué se hizo con la parte YA PAGADA de una devolución de cliente al
// aprobarla (la parte no pagada baja la cartera, ver 2026100901):
//  - 'refund': se le devolvió el dinero -- salida de la caja abierta o de una
//    cuenta bancaria (refund_*), visible en el cuadre y en Flujo de Caja.
//  - 'credit': quedó como saldo a favor -- anticipo del cliente
//    (credit_advance_id). customer_advances.customer_return_id marca ese
//    anticipo para que Flujo de Caja no lo cuente como dinero nuevo.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE customer_returns
        ADD COLUMN IF NOT EXISTS settlement_type VARCHAR(10),
        ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS refund_method VARCHAR(50),
        ADD COLUMN IF NOT EXISTS refund_bank_account_id UUID,
        ADD COLUMN IF NOT EXISTS refund_cash_session_id UUID,
        ADD COLUMN IF NOT EXISTS refund_branch_id UUID,
        ADD COLUMN IF NOT EXISTS refund_date TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS credit_advance_id UUID
    `);
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_advances ADD COLUMN IF NOT EXISTS customer_return_id UUID`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE customer_returns
        DROP COLUMN IF EXISTS settlement_type,
        DROP COLUMN IF EXISTS refund_amount,
        DROP COLUMN IF EXISTS refund_method,
        DROP COLUMN IF EXISTS refund_bank_account_id,
        DROP COLUMN IF EXISTS refund_cash_session_id,
        DROP COLUMN IF EXISTS refund_branch_id,
        DROP COLUMN IF EXISTS refund_date,
        DROP COLUMN IF EXISTS credit_advance_id
    `);
    await queryInterface.sequelize.query(`ALTER TABLE customer_advances DROP COLUMN IF EXISTS customer_return_id`);
  },
};
