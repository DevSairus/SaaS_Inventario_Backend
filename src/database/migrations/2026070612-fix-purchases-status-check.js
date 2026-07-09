'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // El modelo Purchase usa: draft, confirmed, received, cancelled.
      // El CHECK real de la base solo permitía: draft, pending, partial, completed, cancelled.
      // Se amplía a la UNIÓN de ambos conjuntos (no se quita ningún valor existente,
      // para no romper filas históricas que ya tengan 'pending'/'partial'/'completed').
      await queryInterface.sequelize.query(
        `ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check`,
        { transaction }
      );
      await queryInterface.sequelize.query(`
        ALTER TABLE purchases ADD CONSTRAINT purchases_status_check
        CHECK (status IN ('draft', 'pending', 'partial', 'completed', 'cancelled', 'confirmed', 'received'))
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No se revierte: reducir el CHECK podría romper filas ya creadas con los nuevos valores.
  },
};
