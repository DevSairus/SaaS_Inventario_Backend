'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // El modelo ya define estas columnas como allowNull:true, pero la base
      // conserva la restricción NOT NULL de una versión anterior del esquema
      // (de cuando 'supplier_name'/'warehouse_id' eran obligatorios, antes
      // de existir 'supplier_id' FK y el soporte multi-bodega/multi-sede).
      await queryInterface.sequelize.query(
        `ALTER TABLE purchases ALTER COLUMN supplier_name DROP NOT NULL`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE purchases ALTER COLUMN warehouse_id DROP NOT NULL`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE suppliers ALTER COLUMN business_name DROP NOT NULL`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    // No se revierte: volver a NOT NULL podría romper filas ya insertadas sin esos valores.
  },
};
