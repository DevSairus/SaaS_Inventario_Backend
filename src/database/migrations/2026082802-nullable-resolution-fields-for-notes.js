'use strict';

// Las notas crédito/débito NO requieren resolución de numeración de la DIAN
// (ni número de resolución, ni vigencia) -- a diferencia de la factura
// electrónica, la numeración de NC/ND la define y controla el propio
// facturador. Estos campos dejan de ser obligatorios para permitir
// registrar una "resolución" de NC/ND con solo prefijo + rango.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        ALTER TABLE dian_resolutions
          ALTER COLUMN resolution_number DROP NOT NULL,
          ALTER COLUMN resolution_date DROP NOT NULL,
          ALTER COLUMN valid_from DROP NOT NULL,
          ALTER COLUMN valid_to DROP NOT NULL;
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE dian_resolutions
        ALTER COLUMN resolution_number SET NOT NULL,
        ALTER COLUMN resolution_date SET NOT NULL,
        ALTER COLUMN valid_from SET NOT NULL,
        ALTER COLUMN valid_to SET NOT NULL;
    `);
  },
};
