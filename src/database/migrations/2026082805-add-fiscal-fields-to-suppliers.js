'use strict';

// §2 del plan: hoy `suppliers` no tiene ningún dato que le diga al sistema
// "este proveedor no está obligado a facturar". `is_obligated_to_invoice`
// (default true, para no romper proveedores existentes) es el campo que
// realmente importa: si es false, las compras a ese proveedor requieren
// Documento Soporte en vez de esperar una factura de él.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE suppliers
        ADD COLUMN IF NOT EXISTS person_type VARCHAR(20),
        ADD COLUMN IF NOT EXISTS tax_regime VARCHAR(20),
        ADD COLUMN IF NOT EXISTS fiscal_responsibilities JSONB DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS is_obligated_to_invoice BOOLEAN NOT NULL DEFAULT true
    `);
    console.log('[Migration] suppliers: person_type, tax_regime, fiscal_responsibilities, is_obligated_to_invoice agregadas');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE suppliers
        DROP COLUMN IF EXISTS person_type,
        DROP COLUMN IF EXISTS tax_regime,
        DROP COLUMN IF EXISTS fiscal_responsibilities,
        DROP COLUMN IF EXISTS is_obligated_to_invoice
    `);
  },
};
