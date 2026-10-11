'use strict';

// Montos con los que se liquidó una devolución, fijados AL APROBAR (con la
// venta/compra bloqueada) y usados tal cual por el asiento -- antes el asiento
// los recalculaba después, con una proporción pagado/pendiente que fallaba
// con devoluciones sucesivas y pagos intermedios.
//
// Regla: la devolución reduce primero lo que se debe (cartera / CxP); solo el
// excedente es dinero a devolver o saldo a favor. Las retenciones se reversan
// en proporción a lo devuelto (cliente: lo que el cliente retuvo y nunca entró
// a caja; proveedor: lo que se le retuvo y se le debe a la DIAN).
//
//   *_reduction        -> baja la cartera (cliente) o la CxP (proveedor)
//   retention_reversal -> { retefuente, reteiva, reteica } reversado
//   money_back_amount  -> excedente: refund (caja/banco) o credit (saldo a favor)

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE customer_returns
        ADD COLUMN IF NOT EXISTS receivable_reduction DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS money_back_amount DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS retention_reversal JSONB
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE supplier_returns
        ADD COLUMN IF NOT EXISTS payable_reduction DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS money_back_amount DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS retention_reversal JSONB,
        ADD COLUMN IF NOT EXISTS support_adjustment_id UUID
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE customer_returns
        DROP COLUMN IF EXISTS receivable_reduction,
        DROP COLUMN IF EXISTS money_back_amount,
        DROP COLUMN IF EXISTS retention_reversal
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE supplier_returns
        DROP COLUMN IF EXISTS payable_reduction,
        DROP COLUMN IF EXISTS money_back_amount,
        DROP COLUMN IF EXISTS retention_reversal,
        DROP COLUMN IF EXISTS support_adjustment_id
    `);
  },
};
