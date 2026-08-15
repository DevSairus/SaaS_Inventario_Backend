'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('commission_settlements', 'expense_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'expenses', key: 'id' },
      onDelete: 'SET NULL',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('commission_settlements', 'expense_id');
  },
};
