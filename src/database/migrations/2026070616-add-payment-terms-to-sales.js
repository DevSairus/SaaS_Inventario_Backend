'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_terms INTEGER`
    );
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('sales', 'payment_terms');
  },
};
