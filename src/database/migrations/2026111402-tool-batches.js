'use strict';

// Checklist masivo de herramientas por lote y etapa (Fase 4, req. 1.5; cubre
// 2.5). Ver services/tools/toolBatches.service.js.
//
//   tool_batches            un lote = una entrega (delivery) o devolución
//                           (return) de varias herramientas a una obra, con
//                           etapa opcional (project_stages, ver 1.2).
//   tool_batch_items        las asignaciones (tool_assignments) del lote: cada
//                           herramienta sigue teniendo su propia entrega/
//                           devolución y su cargo por uso; el lote las agrupa
//                           bajo un acta con consecutivo LOT-000001.
//   tool_batch_signatures   firma dibujada en pantalla de cada rol (almacén,
//                           transportador, encargado de obra); una por rol.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS tool_batches (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          batch_no VARCHAR(20) NOT NULL,
          kind VARCHAR(10) NOT NULL CHECK (kind IN ('delivery', 'return')),
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          stage_id UUID REFERENCES project_stages(id) ON DELETE SET NULL ON UPDATE CASCADE,
          batch_date DATE NOT NULL,
          responsible_name VARCHAR(200),
          responsible_document VARCHAR(30),
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS tool_batches_no_uq ON tool_batches (tenant_id, batch_no)`);
      await q(`CREATE INDEX IF NOT EXISTS tool_batches_project_idx ON tool_batches (project_id, created_at DESC)`);
      await q(`CREATE INDEX IF NOT EXISTS tool_batches_stage_idx ON tool_batches (stage_id) WHERE stage_id IS NOT NULL`);

      await q(`
        CREATE TABLE IF NOT EXISTS tool_batch_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          batch_id UUID NOT NULL REFERENCES tool_batches(id) ON DELETE CASCADE ON UPDATE CASCADE,
          assignment_id UUID NOT NULL REFERENCES tool_assignments(id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS tool_batch_items_uq ON tool_batch_items (batch_id, assignment_id)`);
      await q(`CREATE INDEX IF NOT EXISTS tool_batch_items_assignment_idx ON tool_batch_items (assignment_id)`);

      await q(`
        CREATE TABLE IF NOT EXISTS tool_batch_signatures (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          batch_id UUID NOT NULL REFERENCES tool_batches(id) ON DELETE CASCADE ON UPDATE CASCADE,
          role VARCHAR(20) NOT NULL CHECK (role IN ('almacen', 'transportador', 'encargado_obra')),
          signed_name VARCHAR(200) NOT NULL,
          signed_document VARCHAR(30),
          signature TEXT NOT NULL,
          signed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          registered_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS tool_batch_signatures_role_uq ON tool_batch_signatures (batch_id, role)`);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP TABLE IF EXISTS tool_batch_signatures`);
    await q(`DROP TABLE IF EXISTS tool_batch_items`);
    await q(`DROP TABLE IF EXISTS tool_batches`);
  },
};
