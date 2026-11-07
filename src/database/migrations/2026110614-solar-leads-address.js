'use strict';

// Dirección del inmueble del interesado del simulador solar (opcional): sirve
// para agendar la visita técnica. No se usa en el cálculo (la radiación sale
// de NASA POWER por municipio).

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE solar_leads ADD COLUMN IF NOT EXISTS address VARCHAR(255)`);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE solar_leads DROP COLUMN IF EXISTS address`);
  },
};
