'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS movement_reason VARCHAR(100) NOT NULL DEFAULT 'movimiento'`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS movement_reason`);
  },
};
