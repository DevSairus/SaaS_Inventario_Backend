'use strict';

// 6.5 — Vacaciones fuera de período: documento propio de liquidación y pago
// directo de vacaciones (disfrutadas y/o compensadas), sin esperar a un período.
//   status: 'borrador' (calculado) -> 'pagada' (contabilizada y desembolsada) | 'anulada'
//   payroll_period_id: período de nómina que ya la absorbió (para el reporte DIAN);
//   mientras sea NULL, el libro de vacaciones la cuenta igual.
//   novedad_ids: novedades que creó al absorberla (para poder desligarla).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. Se omite si no existe `employees` (schema public).

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      DO $$ BEGIN
        IF to_regclass('employees') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS payroll_vacation_settlements (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id UUID NOT NULL,
            employee_id UUID NOT NULL REFERENCES employees(id),
            doc_number INTEGER NOT NULL,
            status VARCHAR(12) NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'pagada', 'anulada')),
            start_date DATE,
            end_date DATE,
            days_enjoyed NUMERIC(6,2) NOT NULL DEFAULT 0,
            days_compensated NUMERIC(6,2) NOT NULL DEFAULT 0,
            base_salary NUMERIC(15,2) NOT NULL DEFAULT 0,
            daily_value NUMERIC(15,2) NOT NULL DEFAULT 0,
            value_enjoyed NUMERIC(15,2) NOT NULL DEFAULT 0,
            value_compensated NUMERIC(15,2) NOT NULL DEFAULT 0,
            total_value NUMERIC(15,2) NOT NULL DEFAULT 0,
            payment_date DATE,
            bank_account_id UUID,
            reference VARCHAR(100),
            journal_entry_id UUID,
            payroll_period_id UUID,
            novedad_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            notes TEXT,
            created_by UUID,
            paid_by UUID,
            voided_by UUID,
            voided_at TIMESTAMP WITH TIME ZONE,
            void_reason TEXT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            CONSTRAINT payroll_vacation_settlements_days_check CHECK (days_enjoyed >= 0 AND days_compensated >= 0 AND days_enjoyed + days_compensated > 0)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS payroll_vacation_settlements_number_uq ON payroll_vacation_settlements (tenant_id, doc_number);
          CREATE INDEX IF NOT EXISTS payroll_vacation_settlements_employee_idx ON payroll_vacation_settlements (tenant_id, employee_id, status);
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS payroll_vacation_settlements');
  },
};
