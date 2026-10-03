'use strict';

// Historial de envíos de la orden de compra al proveedor por correo:
// [{ date, to: [...], cc: [...], user_id, message_id }].

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS order_emails JSONB DEFAULT '[]'`);
    console.log('[Migration] purchases.order_emails agregada');
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS order_emails`);
  },
};
