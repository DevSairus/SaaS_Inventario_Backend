'use strict';

// PayrollConcept ya tenía `calculation_type` (fixed/percentage/formula/
// manual) y `default_value`, pero nunca se usaban al liquidar — un
// concepto solo servía de etiqueta de referencia. auto_apply es el
// interruptor explícito: si está en true, el concepto se aplica solo a
// todos los empleados liquidados en cada periodo (ver
// payrollService.js#liquidarEmpleado). Default false para no cambiar el
// comportamiento de ningún concepto existente al desplegar esto.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE payroll_concepts
        ADD COLUMN IF NOT EXISTS auto_apply BOOLEAN NOT NULL DEFAULT false
    `);
    console.log('[Migration] payroll_concepts: +auto_apply (default false)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE payroll_concepts
        DROP COLUMN IF EXISTS auto_apply
    `);
  },
};
