'use strict';

// Devoluciones a proveedor con el mismo esquema que las de cliente
// (2026100901/2026100902):
//  - purchases.returned_amount: parte NO pagada de la compra que se canceló
//    con devoluciones aprobadas (saldo CxP = neto - pagado - devuelto).
//  - supplier_returns.settlement_type para la parte YA PAGADA:
//      'refund' -> el proveedor devuelve el dinero (entra a caja/banco, refund_*)
//      'credit' -> saldo a favor con el proveedor: se aplica a sus compras
//                  pendientes (credit_applications) y lo que sobre queda en
//                  credit_amount - credit_applied_amount para aplicar después.
//  - customer_returns.credit_note_sale_id: nota crédito electrónica emitida al
//    aprobar una devolución sobre una factura aceptada por la DIAN.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS returned_amount DECIMAL(15,2) NOT NULL DEFAULT 0`
    );
    await queryInterface.sequelize.query(`
      ALTER TABLE supplier_returns
        ADD COLUMN IF NOT EXISTS settlement_type VARCHAR(10),
        ADD COLUMN IF NOT EXISTS refund_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS refund_method VARCHAR(50),
        ADD COLUMN IF NOT EXISTS refund_bank_account_id UUID,
        ADD COLUMN IF NOT EXISTS refund_cash_session_id UUID,
        ADD COLUMN IF NOT EXISTS refund_branch_id UUID,
        ADD COLUMN IF NOT EXISTS refund_date TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS credit_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS credit_applied_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS credit_applications JSONB NOT NULL DEFAULT '[]'::jsonb
    `);
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_returns ADD COLUMN IF NOT EXISTS credit_note_sale_id UUID`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS returned_amount`);
    await queryInterface.sequelize.query(`
      ALTER TABLE supplier_returns
        DROP COLUMN IF EXISTS settlement_type,
        DROP COLUMN IF EXISTS refund_amount,
        DROP COLUMN IF EXISTS refund_method,
        DROP COLUMN IF EXISTS refund_bank_account_id,
        DROP COLUMN IF EXISTS refund_cash_session_id,
        DROP COLUMN IF EXISTS refund_branch_id,
        DROP COLUMN IF EXISTS refund_date,
        DROP COLUMN IF EXISTS credit_amount,
        DROP COLUMN IF EXISTS credit_applied_amount,
        DROP COLUMN IF EXISTS credit_applications
    `);
    await queryInterface.sequelize.query(`ALTER TABLE customer_returns DROP COLUMN IF EXISTS credit_note_sale_id`);
  },
};
