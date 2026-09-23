'use strict';

// Las líneas libres (item_type='free_line') guardan en `product_name` la
// descripción que escribe el usuario (ej. el detalle de un trabajo de
// taller), que no tiene por qué caber en 255 caracteres. Con VARCHAR(255)
// crear la venta reventaba en SaleItem.bulkCreate con "value too long for
// type character varying(255)" y el usuario solo veía un 500 genérico al
// facturar. No es dato a truncar (sale en la factura), así que se pasa a
// TEXT -- tanto en `sale_items` como en `work_order_items`, que es de donde
// vienen muchas de esas líneas al facturar una OT.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query('ALTER TABLE sale_items ALTER COLUMN product_name TYPE TEXT');
    await q.query('ALTER TABLE work_order_items ALTER COLUMN product_name TYPE TEXT');
    console.log('[Migration] sale_items/work_order_items: product_name ampliado a TEXT');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query('ALTER TABLE sale_items ALTER COLUMN product_name TYPE VARCHAR(255)');
    await q.query('ALTER TABLE work_order_items ALTER COLUMN product_name TYPE VARCHAR(255)');
  },
};
