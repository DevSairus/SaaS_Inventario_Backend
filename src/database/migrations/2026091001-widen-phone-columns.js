'use strict';

// Facturas DIAN reales traen más de un número en el mismo campo de teléfono
// (ej. "3102740373 - 3184415398", dos líneas de contacto separadas por " - ")
// -- con VARCHAR(20) eso revienta la importación con "value too long for
// type character varying(20)" apenas el proveedor no existía todavía y
// findOrCreateSupplier intenta crearlo (invoiceImport.controller.js). No es
// basura a truncar: son datos de contacto reales del proveedor. Se amplía a
// VARCHAR(50) -- de sobra para varios números, extensión, etc. -- tanto en
// `suppliers` (phone, mobile, contact_phone) como en `customers` (mismo
// campo, mismo riesgo si algún día se alimenta de una fuente externa
// parecida).
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE suppliers
        ALTER COLUMN phone TYPE VARCHAR(50),
        ALTER COLUMN mobile TYPE VARCHAR(50),
        ALTER COLUMN contact_phone TYPE VARCHAR(50)
    `);
    await q.query(`
      ALTER TABLE customers
        ALTER COLUMN phone TYPE VARCHAR(50),
        ALTER COLUMN mobile TYPE VARCHAR(50)
    `);
    console.log('[Migration] suppliers/customers: columnas de teléfono ampliadas a VARCHAR(50)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE suppliers
        ALTER COLUMN phone TYPE VARCHAR(20),
        ALTER COLUMN mobile TYPE VARCHAR(20),
        ALTER COLUMN contact_phone TYPE VARCHAR(20)
    `);
    await q.query(`
      ALTER TABLE customers
        ALTER COLUMN phone TYPE VARCHAR(20),
        ALTER COLUMN mobile TYPE VARCHAR(20)
    `);
  },
};
