'use strict';

// Formato 1012 de Exógena (saldos de cuentas corrientes/ahorro) exige
// reportar razón social e identificación de la ENTIDAD FINANCIERA (el
// banco), no del tenant -- BankAccount (Fase 3) solo guardaba el nombre del
// banco, no su NIT. Ver Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4,
// Grupo B (1012).

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE bank_accounts
      ADD COLUMN IF NOT EXISTS bank_tax_id VARCHAR(20);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE bank_accounts DROP COLUMN IF EXISTS bank_tax_id;
    `);
  },
};
