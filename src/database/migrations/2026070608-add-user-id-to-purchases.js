'use strict';

module.exports = {
  up: async (queryInterface) => {
    // Nullable, igual que en el modelo (comentario "ahora es opcional") — no
    // hay valor de fallback razonable para las filas históricas.
    await queryInterface.sequelize.query(
      `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS user_id UUID`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE purchases DROP COLUMN IF EXISTS user_id`);
  },
};
