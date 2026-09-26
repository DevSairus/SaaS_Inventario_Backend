'use strict';

// Token permanente del portal público del vehículo (/portal/vehiculo/:token).
// A diferencia de WorkOrder.share_token (uno por OT), este es UNO por
// vehículo y NUNCA se regenera: va impreso en el sticker QR que se pega en
// el vehículo, así que cambiarlo dejaría inservible el sticker ya pegado.
// Se genera perezosamente (ver ensurePortalToken en vehicles.controller.js).
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // OJO: provisionTenantSchema.js corre esto con un pool de UNA sola
      // conexión -- SQL crudo con { transaction } en vez de addColumn (ver
      // 2026082101-add-global-discount-to-work-orders-and-sales.js).
      await queryInterface.sequelize.query(
        'ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS portal_token UUID',
        { transaction }
      );
      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS vehicles_portal_token_unique ON vehicles (portal_token)',
        { transaction }
      );
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS vehicles_portal_token_unique');
    await queryInterface.sequelize.query('ALTER TABLE vehicles DROP COLUMN IF EXISTS portal_token');
  },
};
