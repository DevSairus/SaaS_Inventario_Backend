'use strict';

// Necesarios para armar correctamente el `AccountingSupplierParty` del
// Documento Soporte (dianKitAdapter.js#buildSellerFromSupplier, Fase 2).
// Sin esto, cualquier proveedor sin ciudad DIVIPOLA cae en el fallback
// hardcodeado de buildCounterpartyData (Bogotá D.C./Cundinamarca) — el
// mismo tipo de bug que ya se corrigió para Customer en
// 2026082302-add-dian-address-fields-to-customer-and-sale.js.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE suppliers
        ADD COLUMN IF NOT EXISTS city_code VARCHAR(5),
        ADD COLUMN IF NOT EXISTS document_type VARCHAR(5)
    `);
    console.log('[Migration] suppliers: city_code y document_type agregados');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE suppliers
        DROP COLUMN IF EXISTS city_code,
        DROP COLUMN IF EXISTS document_type
    `);
  },
};
