'use strict';

// Libro de vacaciones: saldo inicial por empleado.
//
//   vacation_opening_days: días de vacaciones pendientes que el empleado
//     traía a la fecha de corte (lo causado y no tomado antes de llevar la
//     nómina en Pitbox). Puede ser negativo si se le adelantaron días.
//   vacation_opening_date: fecha de corte de ese saldo. Desde ella se causan
//     días nuevos y se cuentan las novedades de vacaciones; las novedades de
//     periodos anteriores se suponen incluidas en el saldo.
//
// Sin saldo inicial, el libro cuenta desde la fecha de ingreso con todas las
// novedades (comportamiento anterior). Ver services/payroll/vacationBook.service.js.

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS vacation_opening_days DECIMAL(7, 2)`);
    await q(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS vacation_opening_date DATE`);
  },
  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE employees DROP COLUMN IF EXISTS vacation_opening_date`);
    await q(`ALTER TABLE employees DROP COLUMN IF EXISTS vacation_opening_days`);
  },
};
