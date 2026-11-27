'use strict';

// Hoja de vida 360 del vehículo + peritajes vehiculares.
// Ver services/workshop/vehicle360.service.js e inspections.service.js.
//
//   vehicle_owners: historial de propietarios. Se agrega una fila cada vez
//     que cambia vehicles.customer_id (vehicles.controller update) y se
//     cierra la anterior. Esta migración solo SIEMBRA la fila del
//     propietario actual (source 'inicial', desde la creación del vehículo);
//     no reconstruye historia que no conocemos.
//   vehicle_runt_snapshots: cada consulta RUNT hecha desde la ficha queda
//     guardada (prendas, gravámenes, estado, SOAT/RTM) para la línea de
//     tiempo y para los peritajes.
//   inspection_templates: plantillas de peritaje de la empresa (copias
//     editables de las de Pitbox, constants/inspectionTemplates.js).
//   vehicle_inspections: el peritaje (PER-000001). La plantilla se congela en
//     template_snapshot. verify_token = enlace público de verificación del
//     certificado; is_public = sale el resumen en el portal del sticker.
//   vehicle_inspection_items: resultado de cada punto de la plantilla.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS vehicle_owners (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
          customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          started_at DATE NOT NULL,
          ended_at DATE,
          source VARCHAR(20) NOT NULL DEFAULT 'cambio' CHECK (source IN ('inicial', 'cambio', 'manual')),
          notes VARCHAR(500),
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS vehicle_owners_vehicle_idx ON vehicle_owners (vehicle_id, started_at)`);
      await q(`CREATE INDEX IF NOT EXISTS vehicle_owners_customer_idx ON vehicle_owners (customer_id)`);

      // Propietario actual de cada vehículo. Idempotente: solo vehículos que
      // aún no tienen ninguna fila.
      await q(`
        INSERT INTO vehicle_owners (tenant_id, vehicle_id, customer_id, started_at, source)
        SELECT v.tenant_id, v.id, v.customer_id, v.created_at::date, 'inicial'
        FROM vehicles v
        WHERE v.customer_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM vehicle_owners o WHERE o.vehicle_id = v.id)
      `);

      await q(`
        CREATE TABLE IF NOT EXISTS vehicle_runt_snapshots (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE ON UPDATE CASCADE,
          consulted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          consulted_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          estado VARCHAR(60),
          has_liens BOOLEAN,
          has_pledges BOOLEAN,
          soat_expiry DATE,
          tecnomecanica_expiry DATE,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS vehicle_runt_snapshots_vehicle_idx ON vehicle_runt_snapshots (vehicle_id, consulted_at DESC)`);

      await q(`
        CREATE TABLE IF NOT EXISTS inspection_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(150) NOT NULL,
          base_key VARCHAR(30),
          vehicle_types JSONB NOT NULL DEFAULT '[]'::jsonb,
          sections JSONB NOT NULL DEFAULT '[]'::jsonb,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS inspection_templates_tenant_idx ON inspection_templates (tenant_id, is_active)`);

      await q(`
        CREATE TABLE IF NOT EXISTS vehicle_inspections (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          number VARCHAR(30) NOT NULL,
          vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          owner_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          requester_type VARCHAR(20) NOT NULL DEFAULT 'propietario'
            CHECK (requester_type IN ('propietario', 'comprador', 'financiera', 'aseguradora', 'concesionario', 'otro')),
          requester_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          requester_name VARCHAR(200),
          requester_document VARCHAR(30),
          requester_phone VARCHAR(30),
          requester_email VARCHAR(150),
          purpose VARCHAR(20) NOT NULL DEFAULT 'compraventa'
            CHECK (purpose IN ('compraventa', 'financiacion', 'seguro', 'control', 'otro')),
          template_id UUID REFERENCES inspection_templates(id) ON DELETE SET NULL ON UPDATE CASCADE,
          template_name VARCHAR(150),
          template_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
          inspector_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          inspected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          mileage INTEGER,
          meter_unit VARCHAR(2) NOT NULL DEFAULT 'km',
          status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'cancelled')),
          score DECIMAL(5, 1),
          suggested_concept VARCHAR(30),
          concept VARCHAR(30) CHECK (concept IS NULL OR concept IN ('aprobado', 'aprobado_observaciones', 'no_recomendado')),
          section_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
          conclusion TEXT,
          recommendations TEXT,
          body_marks JSONB NOT NULL DEFAULT '[]'::jsonb,
          paint_readings JSONB NOT NULL DEFAULT '{}'::jsonb,
          identity JSONB NOT NULL DEFAULT '{}'::jsonb,
          runt_snapshot_id UUID REFERENCES vehicle_runt_snapshots(id) ON DELETE SET NULL ON UPDATE CASCADE,
          photos JSONB NOT NULL DEFAULT '[]'::jsonb,
          inspector_signature TEXT,
          price DECIMAL(15, 2),
          is_public BOOLEAN NOT NULL DEFAULT FALSE,
          verify_token UUID NOT NULL DEFAULT gen_random_uuid(),
          work_order_id UUID REFERENCES work_orders(id) ON DELETE SET NULL ON UPDATE CASCADE,
          sale_id UUID REFERENCES sales(id) ON DELETE SET NULL ON UPDATE CASCADE,
          finalized_at TIMESTAMP WITH TIME ZONE,
          finalized_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          cancelled_at TIMESTAMP WITH TIME ZONE,
          cancel_reason VARCHAR(500),
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS vehicle_inspections_tenant_number_uq ON vehicle_inspections (tenant_id, number)`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS vehicle_inspections_verify_token_uq ON vehicle_inspections (verify_token)`);
      await q(`CREATE INDEX IF NOT EXISTS vehicle_inspections_vehicle_idx ON vehicle_inspections (vehicle_id, inspected_at DESC)`);
      await q(`CREATE INDEX IF NOT EXISTS vehicle_inspections_tenant_status_idx ON vehicle_inspections (tenant_id, status, inspected_at DESC)`);

      await q(`
        CREATE TABLE IF NOT EXISTS vehicle_inspection_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          inspection_id UUID NOT NULL REFERENCES vehicle_inspections(id) ON DELETE CASCADE ON UPDATE CASCADE,
          section_key VARCHAR(50) NOT NULL,
          item_key VARCHAR(50) NOT NULL,
          label VARCHAR(150) NOT NULL,
          kind VARCHAR(10) NOT NULL DEFAULT 'rating',
          unit VARCHAR(10),
          critical BOOLEAN NOT NULL DEFAULT FALSE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          rating VARCHAR(10) CHECK (rating IS NULL OR rating IN ('bueno', 'regular', 'malo', 'na')),
          measure DECIMAL(12, 2),
          notes VARCHAR(1000),
          photos JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS vehicle_inspection_items_uq ON vehicle_inspection_items (inspection_id, section_key, item_key)`);

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TABLE IF EXISTS vehicle_inspection_items');
    await q('DROP TABLE IF EXISTS vehicle_inspections');
    await q('DROP TABLE IF EXISTS inspection_templates');
    await q('DROP TABLE IF EXISTS vehicle_runt_snapshots');
    await q('DROP TABLE IF EXISTS vehicle_owners');
  },
};
