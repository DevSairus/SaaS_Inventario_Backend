'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_history JSONB DEFAULT '[]'::jsonb`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS payment_history`);
  },
};
