'use strict';

// Reasignación de anticipos de cliente a otro cliente (solo contabilidad:
// admin/accountant). El saldo reasignado sale del anticipo original
// (reassigned_amount, reassignment_history) y entra a un anticipo NUEVO del
// cliente destino (reassigned_from_id). No mueve caja: el asiento es
// 280505 tercero origen (débito) vs 280505 tercero destino (crédito),
// source_type 'customer_advance_reassignment'.
//
// Estado 'reassigned': todo el saldo restante del anticipo se reasignó.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE customer_advances
        ADD COLUMN IF NOT EXISTS reassigned_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reassignment_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS reassigned_from_id UUID REFERENCES customer_advances(id) ON DELETE SET NULL
    `);
    await q.query(`ALTER TABLE customer_advances DROP CONSTRAINT IF EXISTS customer_advances_status_check`);
    await q.query(`
      ALTER TABLE customer_advances ADD CONSTRAINT customer_advances_status_check
        CHECK (status IN ('active', 'fully_applied', 'fully_refunded', 'voided', 'reassigned'))
    `);
    console.log('[Migration] Reasignación de anticipos de cliente');
  },
  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE customer_advances DROP CONSTRAINT IF EXISTS customer_advances_status_check`);
    await q.query(`
      ALTER TABLE customer_advances ADD CONSTRAINT customer_advances_status_check
        CHECK (status IN ('active', 'fully_applied', 'fully_refunded', 'voided'))
    `);
    await q.query(`
      ALTER TABLE customer_advances
        DROP COLUMN IF EXISTS reassigned_from_id,
        DROP COLUMN IF EXISTS reassignment_history,
        DROP COLUMN IF EXISTS reassigned_amount
    `);
  },
};
