'use strict';

// Herramientas (Fase 3 del módulo Proyectos). Ver services/tools/tools.service.js.
//
//   tools: hoja de vida de cada herramienta. Individual (una unidad con
//     serial) o por cantidad (p. ej. 10 escaleras iguales). El costo se
//     maneja según cost_mode: 'zero' (solo control, sin valorizar), 'expense'
//     (se llevó al gasto al comprarla) o 'fixed_asset' (vinculada a un activo
//     fijo que se deprecia). usage_rate_daily es un cargo interno opcional
//     que suma al resultado del proyecto mientras está asignada.
//   tool_assignments: entrega a un responsable (empleado o usuario), con o
//     sin proyecto; firma de entrega y de devolución (actas).
//   tool_events: historial (alta, asignación, devolución, mantenimiento,
//     calibración, daño, pérdida, baja, nota).
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS tools (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          code VARCHAR(30) NOT NULL,
          name VARCHAR(200) NOT NULL,
          category VARCHAR(100),
          brand VARCHAR(100),
          model VARCHAR(100),
          serial_number VARCHAR(100),
          tracking VARCHAR(20) NOT NULL DEFAULT 'individual' CHECK (tracking IN ('individual', 'quantity')),
          quantity_total INTEGER NOT NULL DEFAULT 1 CHECK (quantity_total >= 0),
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'retired')),
          cost_mode VARCHAR(20) NOT NULL DEFAULT 'zero' CHECK (cost_mode IN ('zero', 'expense', 'fixed_asset')),
          acquisition_cost DECIMAL(15, 2),
          acquisition_date DATE,
          acquisition_reference VARCHAR(100),
          supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          fixed_asset_id UUID REFERENCES fixed_assets(id) ON DELETE SET NULL ON UPDATE CASCADE,
          usage_rate_daily DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (usage_rate_daily >= 0),
          location VARCHAR(150),
          requires_calibration BOOLEAN NOT NULL DEFAULT FALSE,
          calibration_interval_months INTEGER,
          next_calibration_date DATE,
          maintenance_interval_months INTEGER,
          next_maintenance_date DATE,
          retired_at DATE,
          retirement_reason VARCHAR(255),
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS tools_tenant_code_uq ON tools (tenant_id, code)`);
      await q(`CREATE INDEX IF NOT EXISTS tools_tenant_status_idx ON tools (tenant_id, status)`);

      await q(`
        CREATE TABLE IF NOT EXISTS tool_assignments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          number VARCHAR(30) NOT NULL,
          tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE ON UPDATE CASCADE,
          quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
          employee_id UUID REFERENCES employees(id) ON DELETE SET NULL ON UPDATE CASCADE,
          user_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          responsible_name VARCHAR(200) NOT NULL,
          responsible_document VARCHAR(30),
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned')),
          assigned_at DATE NOT NULL,
          expected_return_date DATE,
          daily_rate DECIMAL(15, 2) NOT NULL DEFAULT 0,
          delivery_condition VARCHAR(20) NOT NULL DEFAULT 'good',
          delivery_notes VARCHAR(500),
          delivery_signature TEXT,
          delivery_signed_name VARCHAR(200),
          delivered_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          returned_at DATE,
          return_condition VARCHAR(20) CHECK (return_condition IN ('good', 'damaged', 'lost')),
          lost_quantity INTEGER NOT NULL DEFAULT 0 CHECK (lost_quantity >= 0),
          return_notes VARCHAR(500),
          return_signature TEXT,
          return_signed_name VARCHAR(200),
          received_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          CHECK (employee_id IS NOT NULL OR user_id IS NOT NULL OR responsible_name <> '')
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS tool_assignments_tenant_number_uq ON tool_assignments (tenant_id, number)`);
      await q(`CREATE INDEX IF NOT EXISTS tool_assignments_tool_idx ON tool_assignments (tool_id, status)`);
      await q(`CREATE INDEX IF NOT EXISTS tool_assignments_project_idx ON tool_assignments (project_id) WHERE project_id IS NOT NULL`);

      await q(`
        CREATE TABLE IF NOT EXISTS tool_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE ON UPDATE CASCADE,
          event_type VARCHAR(20) NOT NULL CHECK (event_type IN (
            'created', 'assigned', 'returned', 'maintenance', 'calibration', 'repair', 'damage', 'lost', 'retired', 'reactivated', 'note'
          )),
          event_date DATE NOT NULL,
          description VARCHAR(500),
          cost DECIMAL(15, 2),
          supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          certificate_number VARCHAR(100),
          next_due_date DATE,
          assignment_id UUID REFERENCES tool_assignments(id) ON DELETE SET NULL ON UPDATE CASCADE,
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS tool_events_tool_idx ON tool_events (tool_id, event_date)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS tool_events`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS tool_assignments`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS tools`);
  },
};
