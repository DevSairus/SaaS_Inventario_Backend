'use strict';

// Meta/WhatsApp Cloud API exige el número en E.164 sin "+" (ej. 573001234567)
// -- hasta ahora `customers.mobile` guardaba solo el número local (sin
// indicativo de país), así que cualquier envío por la Cloud API dependía de
// que alguien lo hubiera prefijado a mano. Se agrega mobile_country_code
// para que el formulario de cliente capture el indicativo explícitamente
// (selector en el frontend, Colombia "57" por defecto) y el backend pueda
// armar el E.164 completo al enviar por WhatsApp.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS mobile_country_code VARCHAR(5) DEFAULT '57'
    `);
    console.log('[Migration] customers: columna mobile_country_code agregada (default 57)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE customers
        DROP COLUMN IF EXISTS mobile_country_code
    `);
  },
};
