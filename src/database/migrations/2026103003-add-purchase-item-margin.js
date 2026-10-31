'use strict';

// Margen de ganancia por línea de compra (opcional). Se escribe al importar
// el XML de la factura, al importar las líneas desde Excel o a mano en la
// compra. NULL = el producto conserva su margen. Si tiene valor, al RECIBIR
// la compra pasa a ser el margen propio del producto (margin_inherited =
// false) y el precio de venta se recalcula con él (purchaseCost.service.js);
// mientras la compra no se reciba, el producto no cambia.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS purchase_items ADD COLUMN IF NOT EXISTS profit_margin_pct DECIMAL(6, 2)
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS purchase_items DROP COLUMN IF EXISTS profit_margin_pct');
  },
};
