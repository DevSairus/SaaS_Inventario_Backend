'use strict';

// Fase C — ReteICA/retenciones en compras.
//
// Las columnas retefuente_rate/amount, reteiva_rate/amount, reteica_rate/amount
// y total_retentions ya existían en `purchases` desde
// 2026070302-add-multi-tax-system.js, pero esa migración no incluyó
// `tax_breakdown` para purchases (sí lo hizo para `sales`). Se agrega aquí
// para poder guardar el desglose de impuestos/retenciones de la compra,
// igual que ya se hace en ventas.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS tax_breakdown JSONB DEFAULT '[]'`);
    console.log('[Migration] purchases.tax_breakdown agregada (Fase C)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS tax_breakdown`);
  }
};
