'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Eliminar el constraint viejo
      await queryInterface.sequelize.query(`
        ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS users_role_check;
      `, { transaction });

      // Crear el constraint actualizado con todos los roles del modelo Sequelize
      await queryInterface.sequelize.query(`
        ALTER TABLE "public"."users" ADD CONSTRAINT users_role_check
        CHECK (role IN ('super_admin', 'admin', 'manager', 'seller', 'warehouse_keeper', 'accountant', 'user', 'viewer', 'technician', 'support'));
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "public"."users" DROP CONSTRAINT IF EXISTS users_role_check;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE "public"."users" ADD CONSTRAINT users_role_check
      CHECK (role IN ('super_admin', 'admin', 'manager', 'seller', 'warehouse_keeper', 'user', 'viewer', 'technician'));
    `);
  },
};
