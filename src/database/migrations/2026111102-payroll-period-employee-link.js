'use strict';

// 6.4 — Liquidación definitiva enlazada de verdad con el empleado.
//  - payroll_periods.employee_id: FK al empleado liquidado (solo períodos
//    'liquidacion'). Reemplaza la búsqueda por texto en `notes`.
//  - payroll_periods.excludes_salary: true cuando el período normal ya pagó los
//    días hasta el retiro y la liquidación solo paga prestaciones y vacaciones
//    (Básico en 0 días); así el salario no se paga dos veces.
//  Se rellena employee_id de las liquidaciones existentes leyendo el UUID que
//  quedaba escrito en `notes` ("... empleado <uuid>, retiro ...").
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id) ON DELETE SET NULL`);
      await q(`ALTER TABLE payroll_periods ADD COLUMN IF NOT EXISTS excludes_salary BOOLEAN NOT NULL DEFAULT FALSE`);
      await q(`
        UPDATE payroll_periods p
           SET employee_id = e.id
          FROM employees e
         WHERE p.period_type = 'liquidacion'
           AND p.employee_id IS NULL
           AND p.tenant_id = e.tenant_id
           AND p.notes ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
           AND e.id::text = substring(p.notes from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
      `);
      await q(`CREATE INDEX IF NOT EXISTS idx_payroll_periods_liquidacion_employee ON payroll_periods (tenant_id, employee_id) WHERE period_type = 'liquidacion'`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`DROP INDEX IF EXISTS idx_payroll_periods_liquidacion_employee`);
      await q(`ALTER TABLE payroll_periods DROP COLUMN IF EXISTS excludes_salary`);
      await q(`ALTER TABLE payroll_periods DROP COLUMN IF EXISTS employee_id`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
