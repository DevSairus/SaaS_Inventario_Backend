'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS previous_stock DECIMAL(15,2) NOT NULL DEFAULT 0`
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS new_stock DECIMAL(15,2) NOT NULL DEFAULT 0`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS previous_stock`);
    await queryInterface.sequelize.query(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS new_stock`);
  },
};
