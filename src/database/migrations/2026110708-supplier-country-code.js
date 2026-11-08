'use strict';

// suppliers.country_code: país del proveedor (alfa-2, tabla DIAN 16.4.1). Con
// un país distinto de CO el Documento Soporte sale como vendedor NO residente
// (CustomizationID 11: ciudad en texto libre, sin DIVIPOLA ni DV). NULL =
// Colombia, como hasta ahora; no se rellena nada.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS country_code VARCHAR(2)`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE suppliers DROP COLUMN IF EXISTS country_code`);
  },
};
