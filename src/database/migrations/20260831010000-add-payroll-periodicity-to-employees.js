'use strict';

// Hasta ahora la periodicidad (mensual/quincenal) solo existía como
// propiedad del PayrollPeriod, elegida a mano al crear cada periodo — el
// sistema no sabía qué periodicidad le correspondía a cada empleado, así
// que un periodo "mensual" incluía a TODOS los empleados activos sin
// distinción. Se agrega payroll_periodicity al empleado (mismo dominio de
// valores que payroll_periods.period_type) para poder filtrar
// automáticamente "¿a quién le toca liquidar en este periodo?" — ver
// payrollPeriodEmissionService.js#getEmployeesActiveInPeriod.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE employees
        ADD COLUMN IF NOT EXISTS payroll_periodicity VARCHAR(20) NOT NULL DEFAULT 'mensual'
          CHECK (payroll_periodicity IN ('mensual','quincenal'))
    `);
    console.log('[Migration] employees: +payroll_periodicity (mensual/quincenal, default mensual)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE employees
        DROP COLUMN IF EXISTS payroll_periodicity
    `);
  },
};
