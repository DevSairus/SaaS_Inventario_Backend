'use strict';

// Horarios, horas extra y distribución entre proyectos (Fase 4, req. 1.1).
// Ver services/projects/workHours.js y services/payroll/projectHoursPayroll.service.js.
//
//   work_shifts                       turnos de la empresa (nombre, entrada,
//                                     salida, descanso) para precargar la planilla.
//   project_time_entries.start_time / end_time / break_minutes / shift_id
//                                     entrada y salida del trabajador en la obra
//                                     (planilla diaria del encargado). Los
//                                     registros viejos (solo horas) siguen valiendo.
//   payroll_novedades.source          'project_hours' = novedad generada desde las
//                                     horas de los proyectos (se regenera; las
//                                     manuales no se tocan).
//   payroll_settings.daily_hours      horas ordinarias por día; vacío = jornada
//                                     semanal / 6. Lo que pase de ahí es hora extra.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS work_shifts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(80) NOT NULL,
          start_time TIME NOT NULL,
          end_time TIME NOT NULL,
          break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0 AND break_minutes <= 480),
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS work_shifts_tenant_idx ON work_shifts (tenant_id)`);

      await q(`ALTER TABLE project_time_entries ADD COLUMN IF NOT EXISTS start_time TIME`);
      await q(`ALTER TABLE project_time_entries ADD COLUMN IF NOT EXISTS end_time TIME`);
      await q(`ALTER TABLE project_time_entries ADD COLUMN IF NOT EXISTS break_minutes INTEGER NOT NULL DEFAULT 0`);
      await q(`ALTER TABLE project_time_entries ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES work_shifts(id) ON DELETE SET NULL ON UPDATE CASCADE`);
      await q(`CREATE INDEX IF NOT EXISTS project_time_entries_emp_date_idx ON project_time_entries (tenant_id, employee_id, work_date)`);

      await q(`ALTER TABLE payroll_novedades ADD COLUMN IF NOT EXISTS source VARCHAR(30)`);
      await q(`ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS daily_hours DECIMAL(4, 2)`);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE payroll_settings DROP COLUMN IF EXISTS daily_hours`);
    await q(`ALTER TABLE payroll_novedades DROP COLUMN IF EXISTS source`);
    await q(`DROP INDEX IF EXISTS project_time_entries_emp_date_idx`);
    for (const col of ['shift_id', 'break_minutes', 'end_time', 'start_time']) {
      // eslint-disable-next-line no-await-in-loop
      await q(`ALTER TABLE project_time_entries DROP COLUMN IF EXISTS ${col}`);
    }
    await q(`DROP TABLE IF EXISTS work_shifts`);
  },
};
