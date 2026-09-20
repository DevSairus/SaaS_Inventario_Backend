'use strict';

// `users` vive SOLO en `public` (ver config/registerTenantSchemaHooks.js,
// PUBLIC_SCHEMA_MODELS), pero migrateAllTenantSchemas.js corre TODAS las
// migraciones dentro del search_path de cada tenant también. addColumn/
// changeColumn/removeColumn NO respetan search_path -- Sequelize resuelve el
// schema desde el argumento `table`, no desde `options.schema` -- así que hay
// que pasar el schema como parte de ese argumento (mismo fix que
// 2026081201-add-cedula-to-users.js, que corrigió este mismo problema en
// esta misma tabla).
const USERS_TABLE = { tableName: 'users', schema: 'public' };

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable(USERS_TABLE);

    if (!existingColumns.has_system_access) {
      await queryInterface.addColumn(USERS_TABLE, 'has_system_access', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'false = técnico solo para asignación de trabajos (sin login, sin email/password_hash)',
      });
    }

    if (existingColumns.email && existingColumns.email.allowNull === false) {
      await queryInterface.changeColumn(USERS_TABLE, 'email', {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      });
    }

    if (existingColumns.password_hash && existingColumns.password_hash.allowNull === false) {
      await queryInterface.changeColumn(USERS_TABLE, 'password_hash', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn(USERS_TABLE, 'password_hash', {
      type: Sequelize.STRING,
      allowNull: false,
    });

    await queryInterface.changeColumn(USERS_TABLE, 'email', {
      type: Sequelize.STRING,
      allowNull: false,
      unique: true,
    });

    await queryInterface.removeColumn(USERS_TABLE, 'has_system_access');
  },
};
