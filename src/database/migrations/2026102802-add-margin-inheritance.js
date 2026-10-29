'use strict';

// Margen de ganancia por categoría y global (ver
// services/inventory/productMargin.service.js).
//
//   categories.profit_margin_percentage: margen sobre la venta de la
//     categoría. NULL = hereda de la categoría padre y, al final, del margen
//     global del tenant (tenants.business_config.default_profit_margin_pct).
//   products.margin_inherited: true = el producto sigue el margen de su
//     categoría (o el global) y products.profit_margin_percentage guarda una
//     copia del margen efectivo, que se actualiza cuando cambia la
//     categoría o el global. false = margen propio del producto.
//
// Los productos existentes quedan con margen propio (false): nada cambia
// hasta que alguien defina márgenes por categoría y los aplique.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS categories ADD COLUMN IF NOT EXISTS profit_margin_percentage DECIMAL(5,2)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS margin_inherited BOOLEAN NOT NULL DEFAULT false
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS products DROP COLUMN IF EXISTS margin_inherited`);
    await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS categories DROP COLUMN IF EXISTS profit_margin_percentage`);
  },
};
