'use strict';

// Mano de obra por proyecto (Fase 2 del módulo Proyectos). Ver
// services/projects/projectLabor.service.js.
//
//   project_time_entries: horas de un empleado en un proyecto en un día.
//   project_labor_allocations: resultado del reparto del costo de nómina de
//     un periodo (devengado + aportes del empleador + provisiones) entre los
//     proyectos, en proporción a las horas. Se recalcula entero por periodo.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS project_time_entries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE,
          work_date DATE NOT NULL,
          hours DECIMAL(5, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
          notes VARCHAR(255),
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS project_time_entries_project_idx ON project_time_entries (project_id, work_date)`);
      await q(`CREATE INDEX IF NOT EXISTS project_time_entries_employee_idx ON project_time_entries (tenant_id, employee_id, work_date)`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_labor_allocations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          payroll_period_id UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE ON UPDATE CASCADE,
          employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          period_end DATE NOT NULL,
          hours DECIMAL(8, 2) NOT NULL,
          base_hours DECIMAL(8, 2) NOT NULL,
          percentage DECIMAL(7, 4) NOT NULL,
          employee_cost DECIMAL(15, 2) NOT NULL,
          amount DECIMAL(15, 2) NOT NULL,
          breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS project_labor_allocations_project_idx ON project_labor_allocations (project_id, period_end)`);
      await q(`CREATE INDEX IF NOT EXISTS project_labor_allocations_period_idx ON project_labor_allocations (tenant_id, payroll_period_id)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS project_labor_allocations`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS project_time_entries`);
  },
};
