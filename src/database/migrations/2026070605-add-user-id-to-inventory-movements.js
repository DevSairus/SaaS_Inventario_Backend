'use strict';

module.exports = {
  up: async (queryInterface) => {
    // Nullable: la tabla ya tiene filas históricas sin este dato y no hay
    // un valor de fallback razonable para hacer backfill. Los movimientos
    // nuevos siempre lo reciben desde createMovement(), que ya lo exige.
    await queryInterface.sequelize.query(
      `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS user_id UUID`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS user_id`);
  },
};
