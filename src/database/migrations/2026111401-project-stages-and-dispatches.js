'use strict';

// Etapas de obra y actas de despacho (Fase 4, req. 1.2). Ver
// services/projects/projectStages.service.js.
//
//   project_stages        etapas de un proyecto (stage_no consecutivo por proyecto).
//   project_stage_items   cantidad de cada línea del BOM que se planea
//                         despachar en la etapa. La suma entre etapas no pasa
//                         de qty_required. Lo despachado NO se guarda: se
//                         deriva de los traslados no cancelados (así un
//                         traslado cancelado o recibido incompleto corrige el
//                         saldo de la etapa solo).
//   project_dispatches    acta de despacho: una por salida de materiales a la
//                         obra (con o sin etapa); apunta al traslado.
//   project_dispatch_signatures
//                         firma dibujada en pantalla por rol (almacén,
//                         transportador, encargado de obra). Sin repositorio
//                         de firmas: cada acta lleva las suyas.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS project_stages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          stage_no INTEGER NOT NULL,
          name VARCHAR(150) NOT NULL,
          description TEXT,
          planned_date DATE,
          status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_stages_project_no_uq ON project_stages (project_id, stage_no)`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_stage_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          stage_id UUID NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE ON UPDATE CASCADE,
          bom_item_id UUID NOT NULL REFERENCES project_bom_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
          qty_planned DECIMAL(15, 4) NOT NULL CHECK (qty_planned > 0)
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_stage_items_stage_bom_uq ON project_stage_items (stage_id, bom_item_id)`);
      await q(`CREATE INDEX IF NOT EXISTS project_stage_items_bom_idx ON project_stage_items (bom_item_id)`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_dispatches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          stage_id UUID REFERENCES project_stages(id) ON DELETE SET NULL ON UPDATE CASCADE,
          dispatch_no VARCHAR(20) NOT NULL,
          transfer_id UUID REFERENCES transfers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          from_warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL ON UPDATE CASCADE,
          notes TEXT,
          dispatched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_dispatches_no_uq ON project_dispatches (tenant_id, dispatch_no)`);
      await q(`CREATE INDEX IF NOT EXISTS project_dispatches_project_idx ON project_dispatches (project_id, dispatched_at DESC)`);
      await q(`CREATE INDEX IF NOT EXISTS project_dispatches_stage_idx ON project_dispatches (stage_id) WHERE stage_id IS NOT NULL`);
      await q(`CREATE INDEX IF NOT EXISTS project_dispatches_transfer_idx ON project_dispatches (transfer_id) WHERE transfer_id IS NOT NULL`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_dispatch_signatures (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          dispatch_id UUID NOT NULL REFERENCES project_dispatches(id) ON DELETE CASCADE ON UPDATE CASCADE,
          role VARCHAR(20) NOT NULL CHECK (role IN ('almacen', 'transportador', 'encargado_obra')),
          signed_name VARCHAR(200) NOT NULL,
          signed_document VARCHAR(30),
          signature TEXT NOT NULL,
          signed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          registered_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_dispatch_signatures_role_uq ON project_dispatch_signatures (dispatch_id, role)`);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS project_dispatch_signatures`);
    await q(`DROP TABLE IF EXISTS project_dispatches`);
    await q(`DROP TABLE IF EXISTS project_stage_items`);
    await q(`DROP TABLE IF EXISTS project_stages`);
  },
};
