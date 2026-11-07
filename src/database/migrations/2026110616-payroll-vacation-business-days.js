'use strict';

// Días hábiles para contar vacaciones: lunes a sábado (por defecto, el sábado
// es hábil según el CST) o lunes a viernes si la empresa no trabaja sábados.
// Lo usa services/payroll/novedadSuggest.service.js.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS vacation_business_days VARCHAR(8) NOT NULL DEFAULT 'mon_sat'`);
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE payroll_settings DROP COLUMN IF EXISTS vacation_business_days`);
  },
};
