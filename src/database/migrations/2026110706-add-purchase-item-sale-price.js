'use strict';

// Precio de venta fijado a mano en una línea de compra (opcional). Se escribe
// al importar el XML/ZIP de la factura o en el formulario de la compra, sobre
// el precio que sale del margen. NULL = el precio se calcula con el margen
// como siempre. Si tiene valor, al RECIBIR la compra pasa tal cual a
// products.base_price (aunque sea menor que el actual: lo decidió el usuario)
// y el margen del producto queda en el que resulta de ese precio
// (purchaseCost.service.js). Un producto nuevo de la importación se crea con él.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS purchase_items ADD COLUMN IF NOT EXISTS sale_price DECIMAL(15, 2)
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS purchase_items DROP COLUMN IF EXISTS sale_price');
  },
};
