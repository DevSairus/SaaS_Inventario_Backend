'use strict';

// Los formularios de ICA se diligencian en múltiplos de mil: opción por
// municipio para aproximar cada renglón (ver services/tax/ica.service.js).

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE ica_municipalities ADD COLUMN IF NOT EXISTS round_thousands BOOLEAN NOT NULL DEFAULT true`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE ica_municipalities DROP COLUMN IF EXISTS round_thousands`);
  },
};
