'use strict';

// Corrección de costo desde el ajuste de precio (AJP-). Con la casilla
// "Corregir también el costo" (permiso inventory.cost_correction, por defecto
// solo el administrador) el costo promedio del producto pasa al costo de
// referencia: salida + entrada en el kárdex por las unidades en existencia y
// un asiento por la diferencia (services/inventory/priceAdjustment.service.js).
// Solo agrega columnas; los AJP anteriores quedan con cost_corrected = false.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS price_adjustments ADD COLUMN IF NOT EXISTS cost_corrected BOOLEAN NOT NULL DEFAULT false
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS price_adjustment_items ADD COLUMN IF NOT EXISTS cost_corrected BOOLEAN NOT NULL DEFAULT false
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS price_adjustment_items ADD COLUMN IF NOT EXISTS new_average_cost DECIMAL(15, 2)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS price_adjustment_items ADD COLUMN IF NOT EXISTS stock_at_correction DECIMAL(15, 4)
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS price_adjustment_items ADD COLUMN IF NOT EXISTS cost_correction_value DECIMAL(15, 2)
    `);
  },

  down: async (queryInterface) => {
    for (const col of ['cost_corrected', 'new_average_cost', 'stock_at_correction', 'cost_correction_value']) {
      await queryInterface.sequelize.query(`ALTER TABLE IF EXISTS price_adjustment_items DROP COLUMN IF EXISTS ${col}`);
    }
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS price_adjustments DROP COLUMN IF EXISTS cost_corrected');
  },
};
