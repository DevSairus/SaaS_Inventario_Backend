'use strict';

// Sin esto, dos importaciones concurrentes del mismo archivo de factura
// (doble clic, reintento del usuario) pasan ambas el chequeo de "¿ya fue
// importada?" (un simple findOne antes de crear, en invoiceImport.controller.js)
// y terminan creando dos compras (`purchases`) con el mismo invoice_number —
// sin que la base de datos lo impida. Este índice único parcial (excluye NULL,
// porque invoice_number es opcional para compras que no vienen de una
// importación) hace que la segunda inserción falle de forma predecible, y el
// controller la convierte en la misma respuesta 409 DUPLICATE_INVOICE que ya
// usa para el caso normal.
module.exports = {
  up: async (queryInterface) => {
    const q = queryInterface.sequelize;

    // Si ya existen compras con invoice_number duplicado (el bug que motivó
    // este índice), un CREATE UNIQUE INDEX normal fallaría y dejaría a este
    // tenant sin poder aplicar el resto de las migraciones. Se detectan y se
    // reportan sin frenar la migración -- hay que resolverlas a mano (fusionar
    // o eliminar la compra duplicada) y volver a correr la migración.
    const [dupes] = await q.query(`
      SELECT tenant_id, invoice_number, COUNT(*) AS count
      FROM purchases
      WHERE invoice_number IS NOT NULL
      GROUP BY tenant_id, invoice_number
      HAVING COUNT(*) > 1
    `);

    if (dupes.length > 0) {
      console.warn(
        `[Migration] purchases: ${dupes.length} factura(s) con invoice_number duplicado -- NO se crea el índice único hasta resolverlas manualmente:`,
        JSON.stringify(dupes)
      );
      return;
    }

    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tenant_invoice_number_unique
      ON purchases (tenant_id, invoice_number)
      WHERE invoice_number IS NOT NULL;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS tenant_invoice_number_unique`);
  }
};
