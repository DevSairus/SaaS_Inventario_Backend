'use strict';

// Factura AIU (Administración, Imprevistos, Utilidad): IVA solo sobre la
// Utilidad. Ver services/sales/aiu.service.js. Los porcentajes por defecto y
// la base de ReteFuente viven en tenants.tax_config.aiu (JSONB, sin columna).

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE sales
        ADD COLUMN IF NOT EXISTS aiu_enabled BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS aiu_admin_pct DECIMAL(5,2),
        ADD COLUMN IF NOT EXISTS aiu_unforeseen_pct DECIMAL(5,2),
        ADD COLUMN IF NOT EXISTS aiu_profit_pct DECIMAL(5,2),
        ADD COLUMN IF NOT EXISTS aiu_direct_amount DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS aiu_admin_amount DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS aiu_unforeseen_amount DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS aiu_profit_amount DECIMAL(15,2),
        ADD COLUMN IF NOT EXISTS aiu_object TEXT
    `);
    console.log('[Migration] Campos AIU en sales');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE sales
        DROP COLUMN IF EXISTS aiu_object,
        DROP COLUMN IF EXISTS aiu_profit_amount,
        DROP COLUMN IF EXISTS aiu_unforeseen_amount,
        DROP COLUMN IF EXISTS aiu_admin_amount,
        DROP COLUMN IF EXISTS aiu_direct_amount,
        DROP COLUMN IF EXISTS aiu_profit_pct,
        DROP COLUMN IF EXISTS aiu_unforeseen_pct,
        DROP COLUMN IF EXISTS aiu_admin_pct,
        DROP COLUMN IF EXISTS aiu_enabled
    `);
  },
};
