'use strict';

// Mejora #5 (Mejoras-Nomina-Sin-PILA-Nexora.md): alertas de vencimiento de
// contrato a término fijo. Employee ya tenía hire_date y contract_type,
// pero ningún campo con la fecha de fin pactada — sin eso no hay nada que
// alertar. contract_end_date es nullable (solo aplica a contract_type='2'
// Término fijo; el resto de tipos de contrato lo dejan en null) y no
// afecta ningún dato existente al desplegar.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS contract_end_date DATE NULL
    `);
    console.log('[Migration] employees: +contract_end_date (nullable)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE employees
        DROP COLUMN IF EXISTS contract_end_date
    `);
  },
};
