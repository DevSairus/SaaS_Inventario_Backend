'use strict';

// Permite crear tipos de evento contable nuevos (no contemplados en el
// catálogo hardcodeado del frontend) directamente desde el CRUD de mapeo de
// cuentas. `label` guarda el nombre visible del tipo, `category` la agrupa
// en la UI, e `is_custom` distingue los tipos creados por el usuario de los
// predefinidos (solo los personalizados se pueden eliminar por completo).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('account_mappings', 'label', {
      type: Sequelize.STRING(150),
      allowNull: true,
    });
    await queryInterface.addColumn('account_mappings', 'category', {
      type: Sequelize.STRING(60),
      allowNull: true,
    });
    await queryInterface.addColumn('account_mappings', 'is_custom', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('account_mappings', 'label');
    await queryInterface.removeColumn('account_mappings', 'category');
    await queryInterface.removeColumn('account_mappings', 'is_custom');
  },
};
