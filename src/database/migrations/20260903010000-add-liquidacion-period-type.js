'use strict';

// Mejora #7 (Liquidación definitiva / finiquito) — payrollTerminationService.js
// necesita crear un PayrollPeriod propio, de UN solo empleado, cuyo rango va
// desde el día siguiente al último periodo ya pagado hasta la fecha de
// retiro. No encaja en 'mensual'/'quincenal' (esos son compartidos por
// varios empleados según su payroll_periodicity) así que se agrega un
// tercer valor de period_type dedicado: 'liquidacion'.
//
// Dos ajustes sobre la tabla existente:
//
// 1. El CHECK de period_type debía ampliarse para admitir el nuevo valor.
//
// 2. El UNIQUE(tenant_id, start_date, end_date) original asume que cada
//    combinación de fechas identifica a un único periodo COMPARTIDO por
//    varios empleados -- cierto para 'mensual'/'quincenal', pero NO para
//    'liquidacion': dos empleados distintos con la misma periodicidad que
//    se retiran el mismo día terminan con el mismo start_date/end_date
//    (el rango pendiente se calcula igual para ambos) y chocarían contra
//    ese UNIQUE si se dejara tal cual. Se reemplaza por un índice único
//    PARCIAL que solo aplica a 'mensual'/'quincenal' -- el comportamiento
//    existente no cambia para esos dos, y 'liquidacion' queda libre de
//    esa restricción (cada liquidación ya es única por sí sola vía su
//    PayrollDocument, que sigue exigiendo un solo documento por
//    empleado+periodo).
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;

    await q.query(`
      ALTER TABLE payroll_periods
        DROP CONSTRAINT IF EXISTS payroll_periods_period_type_check
    `);
    await q.query(`
      ALTER TABLE payroll_periods
        ADD CONSTRAINT payroll_periods_period_type_check
        CHECK (period_type IN ('mensual','quincenal','liquidacion'))
    `);

    await q.query(`
      ALTER TABLE payroll_periods
        DROP CONSTRAINT IF EXISTS tenant_payroll_period_dates_unique
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS tenant_payroll_period_dates_unique
        ON payroll_periods (tenant_id, start_date, end_date)
        WHERE period_type <> 'liquidacion'
    `);

    console.log('[Migration] payroll_periods: period_type admite \'liquidacion\'; UNIQUE(tenant_id,start_date,end_date) ahora parcial (excluye liquidacion)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;

    await q.query(`
      DROP INDEX IF EXISTS tenant_payroll_period_dates_unique
    `);
    // No se restaura el UNIQUE original de forma incondicional: si ya
    // existen periodos 'liquidacion' con fechas repetidas, el ALTER
    // fallaría. Se deja sin ese UNIQUE en el down (más seguro que romper
    // el rollback) -- si hace falta, restaurarlo a mano tras limpiar datos.
    await q.query(`
      ALTER TABLE payroll_periods
        DROP CONSTRAINT IF EXISTS payroll_periods_period_type_check
    `);
    await q.query(`
      ALTER TABLE payroll_periods
        ADD CONSTRAINT payroll_periods_period_type_check
        CHECK (period_type IN ('mensual','quincenal'))
    `);
  },
};
