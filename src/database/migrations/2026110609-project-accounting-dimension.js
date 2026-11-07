'use strict';

// Contabilidad con dimensión de proyecto (Fase 3 del módulo Proyectos). Ver
// services/accounting/projectAccounting.service.js.
//
//   journal_entry_lines.project_id: proyecto de cada línea. Los asientos
//     automáticos de documentos con proyecto (venta, compra, gasto, notas,
//     devoluciones) lo marcan; los manuales lo eligen por línea.
//   project_material_postings: movimientos de kárdex de las bodegas de obra
//     ya llevados al asiento de consumo (Db costo de obra / Cr inventario),
//     para no contabilizarlos dos veces.
//   Cuentas 710505 / 720505 (clase 7) con los mapeos project_material_cost y
//     project_labor_cost para los tenants que ya tienen plan de cuentas
//     (mismo patrón que 2026102401-add-inc-account-mapping.js).
//
// Sin calificar con esquema (salvo tenants, que vive en public).

const ACCOUNTS = [
  { code: '7', name: 'COSTOS DE PRODUCCIÓN O DE OPERACIÓN', parent: null, level: 1, entries: false },
  { code: '71', name: 'Materia Prima', parent: '7', level: 2, entries: false },
  { code: '710505', name: 'Materiales de Obra (Proyectos)', parent: '71', level: 4, entries: true },
  { code: '72', name: 'Mano de Obra Directa', parent: '7', level: 2, entries: false },
  { code: '720505', name: 'Mano de Obra de Obra (Proyectos)', parent: '72', level: 4, entries: true },
];
const MAPPINGS = { project_material_cost: '710505', project_labor_cost: '720505' };

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    try {
      await q(`ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE`);
      await q(`CREATE INDEX IF NOT EXISTS journal_entry_lines_project_idx ON journal_entry_lines (project_id) WHERE project_id IS NOT NULL`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_material_postings (
          movement_id UUID PRIMARY KEY REFERENCES inventory_movements(id) ON DELETE CASCADE ON UPDATE CASCADE,
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          entry_id UUID REFERENCES journal_entries(id) ON DELETE SET NULL ON UPDATE CASCADE,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS project_material_postings_project_idx ON project_material_postings (tenant_id, project_id)`);

      const [tenants] = await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);
      for (const { tenant_id: tenantId } of tenants) {
        const ids = {};
        for (const acc of ACCOUNTS) {
          // eslint-disable-next-line no-await-in-loop
          const [[existing]] = await q(`SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = :code`, { tenantId, code: acc.code });
          if (existing) { ids[acc.code] = existing.id; continue; }
          // eslint-disable-next-line no-await-in-loop
          const [[created]] = await q(
            `INSERT INTO chart_of_accounts
               (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
             VALUES (gen_random_uuid(), :tenantId, :code, :name, 'costo', :parentId, :level, :entries, true, NOW(), NOW())
             RETURNING id`,
            { tenantId, code: acc.code, name: acc.name, parentId: acc.parent ? ids[acc.parent] || null : null, level: acc.level, entries: acc.entries },
          );
          ids[acc.code] = created.id;
        }
        for (const [event, code] of Object.entries(MAPPINGS)) {
          // eslint-disable-next-line no-await-in-loop
          await q(
            `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
             SELECT gen_random_uuid(), :tenantId, :event, :accountId, NOW(), NOW()
              WHERE NOT EXISTS (SELECT 1 FROM account_mappings WHERE tenant_id = :tenantId AND event_type = :event)`,
            { tenantId, event, accountId: ids[code] },
          );
        }
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DELETE FROM account_mappings WHERE event_type IN ('project_material_cost', 'project_labor_cost')`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS project_material_postings`);
    await queryInterface.sequelize.query(`ALTER TABLE journal_entry_lines DROP COLUMN IF EXISTS project_id`);
    // Las cuentas 7xxxx no se borran: pueden tener movimientos.
  },
};
