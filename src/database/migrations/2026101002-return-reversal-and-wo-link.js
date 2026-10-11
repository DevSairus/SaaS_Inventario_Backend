'use strict';

// 1. sale_items.work_order_item_id: línea de la OT de la que salió la línea
//    de la factura (workOrders.controller.js#generateSale). Permite descontar
//    de la comisión de la OT lo devuelto sobre su factura.
// 2. Reversión de una devolución aprobada (customer_returns / supplier_returns
//    pasan a status 'reversed'): quién, cuándo, por qué y, si hubo dinero de
//    por medio, el movimiento de caja/banco que lo deshace (reversal_*). El
//    movimiento original se conserva -- la reversión es un movimiento nuevo,
//    no se reescribe el pasado del cuadre.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS work_order_item_id UUID`
    );
    for (const table of ['customer_returns', 'supplier_returns']) {
      await queryInterface.sequelize.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS reversed_by UUID,
          ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
          ADD COLUMN IF NOT EXISTS reversal_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS reversal_method VARCHAR(50),
          ADD COLUMN IF NOT EXISTS reversal_bank_account_id UUID,
          ADD COLUMN IF NOT EXISTS reversal_cash_session_id UUID,
          ADD COLUMN IF NOT EXISTS reversal_branch_id UUID,
          ADD COLUMN IF NOT EXISTS reversal_entry_id UUID
      `);
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE sale_items DROP COLUMN IF EXISTS work_order_item_id`);
    for (const table of ['customer_returns', 'supplier_returns']) {
      await queryInterface.sequelize.query(`
        ALTER TABLE ${table}
          DROP COLUMN IF EXISTS reversed_by,
          DROP COLUMN IF EXISTS reversed_at,
          DROP COLUMN IF EXISTS reversal_reason,
          DROP COLUMN IF EXISTS reversal_amount,
          DROP COLUMN IF EXISTS reversal_method,
          DROP COLUMN IF EXISTS reversal_bank_account_id,
          DROP COLUMN IF EXISTS reversal_cash_session_id,
          DROP COLUMN IF EXISTS reversal_branch_id,
          DROP COLUMN IF EXISTS reversal_entry_id
      `);
    }
  },
};
