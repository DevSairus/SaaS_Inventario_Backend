'use strict';

// Mantenimientos recurrentes personalizables (Fase 4, req. 1.3). Ver
// services/projects/maintenance.service.js.
//
//   maintenance_installations  sistema instalado de un cliente (lo que se
//                          mantiene). Puede venir de un proyecto de Pitbox
//                          (project_id) o ser anterior a Pitbox (sin proyecto).
//   maintenance_equipment  equipos de la instalación: inversor, paneles,
//                          tablero... con marca, modelo y serial (opcional).
//   maintenance_plans      plan sobre la instalación completa (equipment_id
//                          NULL) o sobre un equipo: frecuencia en meses,
//                          tareas (checklist) y días de aviso antes de vencer.
//   maintenance_visits     visita programada (MNT-000001). Al cerrarla
//                          (checklist, observaciones, firma del cliente) o
//                          cancelarla, se programa la siguiente. Una sola
//                          visita abierta por plan.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS maintenance_installations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE,
          name VARCHAR(200) NOT NULL,
          system_type VARCHAR(100),
          capacity VARCHAR(50),
          site_address TEXT,
          city VARCHAR(100),
          installed_at DATE,
          notes TEXT,
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS maintenance_installations_customer_idx ON maintenance_installations (tenant_id, customer_id)`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS maintenance_installations_project_uq ON maintenance_installations (project_id) WHERE project_id IS NOT NULL`);

      await q(`
        CREATE TABLE IF NOT EXISTS maintenance_equipment (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          installation_id UUID NOT NULL REFERENCES maintenance_installations(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(150) NOT NULL,
          brand VARCHAR(100),
          model VARCHAR(100),
          serial VARCHAR(100),
          location VARCHAR(150),
          installed_at DATE,
          notes TEXT,
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS maintenance_equipment_installation_idx ON maintenance_equipment (installation_id)`);

      await q(`
        CREATE TABLE IF NOT EXISTS maintenance_plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          installation_id UUID NOT NULL REFERENCES maintenance_installations(id) ON DELETE CASCADE ON UPDATE CASCADE,
          equipment_id UUID REFERENCES maintenance_equipment(id) ON DELETE SET NULL ON UPDATE CASCADE,
          name VARCHAR(150) NOT NULL,
          frequency_months INTEGER NOT NULL CHECK (frequency_months BETWEEN 1 AND 60),
          tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
          start_date DATE NOT NULL,
          alert_days_before INTEGER NOT NULL DEFAULT 15 CHECK (alert_days_before BETWEEN 0 AND 90),
          assigned_user_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS maintenance_plans_installation_idx ON maintenance_plans (installation_id)`);

      await q(`
        CREATE TABLE IF NOT EXISTS maintenance_visits (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          plan_id UUID NOT NULL REFERENCES maintenance_plans(id) ON DELETE CASCADE ON UPDATE CASCADE,
          installation_id UUID NOT NULL REFERENCES maintenance_installations(id) ON DELETE CASCADE ON UPDATE CASCADE,
          equipment_id UUID REFERENCES maintenance_equipment(id) ON DELETE SET NULL ON UPDATE CASCADE,
          visit_no VARCHAR(20) NOT NULL,
          scheduled_date DATE NOT NULL,
          status VARCHAR(10) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
          technician_user_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
          observations TEXT,
          cancel_reason TEXT,
          done_at TIMESTAMP WITH TIME ZONE,
          client_name VARCHAR(200),
          client_document VARCHAR(30),
          client_signature TEXT,
          completed_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS maintenance_visits_no_uq ON maintenance_visits (tenant_id, visit_no)`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS maintenance_visits_open_uq ON maintenance_visits (plan_id) WHERE status = 'scheduled'`);
      await q(`CREATE INDEX IF NOT EXISTS maintenance_visits_agenda_idx ON maintenance_visits (tenant_id, status, scheduled_date)`);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS maintenance_visits`);
    await q(`DROP TABLE IF EXISTS maintenance_plans`);
    await q(`DROP TABLE IF EXISTS maintenance_equipment`);
    await q(`DROP TABLE IF EXISTS maintenance_installations`);
  },
};
