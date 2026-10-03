'use strict';

// Recepción parcial de compras.
//
// - status 'partially_received': llegó parte de la mercancía; la compra
//   sigue abierta para nuevas recepciones (antes cualquier recepción dejaba
//   la compra en 'received' aunque llegara la mitad).
// - receipts: historial de recepciones [{ id, date, user_id, items:
//   [{ item_id, product_id, quantity }], amounts: { subtotal, tax, ... },
//   journal_entry_id }]. Cada recepción genera su propio asiento por el valor
//   de lo recibido; la última toma el remanente para que la suma cuadre
//   exacto con la compra.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS receipts JSONB DEFAULT '[]'`);
    await q.query(`ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check`);
    await q.query(`
      ALTER TABLE purchases ADD CONSTRAINT purchases_status_check
      CHECK (status IN ('draft', 'pending', 'partial', 'completed', 'cancelled', 'confirmed', 'received', 'partially_received'))
    `);
    console.log('[Migration] purchases: receipts + estado partially_received');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS receipts`);
    // El CHECK no se reduce: podría romper filas con 'partially_received'.
  },
};
