'use strict';

// Las notas crédito/débito referencian la factura original (para el
// billing reference del XML), pero esa referencia solo vivía en memoria
// durante el primer envío -- nunca se persistía. Reenviar una nota ya
// creada (botón "Reenviar" del historial de ventas) fallaba porque
// resolveNoteReference() no encontraba con qué factura estaba relacionada.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE sales
          ADD COLUMN IF NOT EXISTS reference_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE sales DROP COLUMN IF EXISTS reference_sale_id;
    `);
  },
};
