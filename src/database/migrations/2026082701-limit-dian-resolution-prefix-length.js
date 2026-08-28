'use strict';

// El SDK @dian-kit exige prefix <= 4 caracteres (regla real de la DIAN para
// resoluciones de facturación). El modelo/migración original permitía hasta
// 10, lo que dejaba crear resoluciones que luego revientan con un ZodError
// "too_big" al primer intento de generar una factura contra ellas.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Si ya existe algún prefijo > 4 caracteres, se trunca para no romper
      // la migración — de todas formas esas resoluciones ya eran inválidas
      // ante la DIAN y nunca pudieron facturar con éxito.
      await queryInterface.sequelize.query(`
        UPDATE dian_resolutions SET prefix = LEFT(prefix, 4) WHERE LENGTH(prefix) > 4;
      `, { transaction });

      await queryInterface.sequelize.query(`
        ALTER TABLE dian_resolutions ALTER COLUMN prefix TYPE VARCHAR(4);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE dian_resolutions ALTER COLUMN prefix TYPE VARCHAR(10);
    `);
  },
};
