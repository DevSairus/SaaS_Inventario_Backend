'use strict';

// Cortes de obra y facturación parcial (módulo Proyectos). Ver
// services/projects/projectCuts.service.js.
//
//   project_cuts / project_cut_items: cada corte registra, por línea del
//     contrato (la cotización del proyecto), la cantidad ejecutada acumulada;
//     se factura solo lo nuevo. Acta con firma del cliente.
//   projects.retention_pct: retención de garantía (% de cada factura parcial,
//     antes de IVA) que el cliente retiene hasta la entrega.
//   sales.retention_guarantee_amount / retention_released_at / project_cut_id:
//     la parte retenida no vence hasta liberarla; contablemente pasa de
//     130505 a 130595 (mapeo sale_retention_guarantee).
//   customer_advances.project_id: anticipos del proyecto, que cada factura
//     parcial amortiza en proporción.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public).

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    try {
      await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_pct DECIMAL(5, 2) NOT NULL DEFAULT 0`);
      await q(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention_released_at TIMESTAMP WITH TIME ZONE`);
      await q(`ALTER TABLE customer_advances ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE`);
      await q(`CREATE INDEX IF NOT EXISTS customer_advances_project_idx ON customer_advances (project_id) WHERE project_id IS NOT NULL`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_cuts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          cut_no INTEGER NOT NULL,
          cut_date DATE NOT NULL,
          period_from DATE,
          period_to DATE,
          status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'invoicing', 'invoiced', 'cancelled')),
          global_pct DECIMAL(6, 2),
          notes TEXT,
          direct_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          aiu_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          subtotal DECIMAL(15, 2) NOT NULL DEFAULT 0,
          tax_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          total_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          advance_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          retention_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          net_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          progress_pct DECIMAL(6, 2),
          approved_by_name VARCHAR(200),
          approved_by_document VARCHAR(30),
          approved_signature TEXT,
          approved_at TIMESTAMP WITH TIME ZONE,
          approved_user_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          sale_id UUID REFERENCES sales(id) ON DELETE SET NULL ON UPDATE CASCADE,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS project_cuts_project_no_uq ON project_cuts (project_id, cut_no)`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_cut_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          cut_id UUID NOT NULL REFERENCES project_cuts(id) ON DELETE CASCADE ON UPDATE CASCADE,
          sale_item_id UUID NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
          description VARCHAR(500) NOT NULL,
          qty_contract DECIMAL(15, 4) NOT NULL,
          qty_previous DECIMAL(15, 4) NOT NULL DEFAULT 0,
          qty_cumulative DECIMAL(15, 4) NOT NULL,
          qty_this DECIMAL(15, 4) NOT NULL,
          unit_price DECIMAL(15, 4) NOT NULL,
          tax_pct DECIMAL(5, 2) NOT NULL DEFAULT 0,
          amount DECIMAL(15, 2) NOT NULL
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS project_cut_items_cut_idx ON project_cut_items (cut_id)`);

      await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS retention_guarantee_amount DECIMAL(15, 2) NOT NULL DEFAULT 0`);
      await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS retention_released_at TIMESTAMP WITH TIME ZONE`);
      await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS project_cut_id UUID REFERENCES project_cuts(id) ON DELETE SET NULL ON UPDATE CASCADE`);

      // Cuenta 130595 "Retenciones de garantía por cobrar" bajo 1305 y su mapeo.
      const [tenants] = await q(`SELECT DISTINCT tenant_id FROM chart_of_accounts`);
      for (const { tenant_id: tenantId } of tenants) {
        // eslint-disable-next-line no-await-in-loop
        const [[parent]] = await q(`SELECT id FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '1305'`, { tenantId });
        if (!parent) continue; // plan de cuentas atípico: el mapeo se configura a mano
        // eslint-disable-next-line no-await-in-loop
        await q(
          `INSERT INTO chart_of_accounts (id, tenant_id, code, name, account_type, parent_id, level, accepts_entries, is_active, created_at, updated_at)
           SELECT gen_random_uuid(), :tenantId, '130595', 'Retenciones de Garantía por Cobrar', 'activo', :parentId, 4, true, true, NOW(), NOW()
            WHERE NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE tenant_id = :tenantId AND code = '130595')`,
          { tenantId, parentId: parent.id },
        );
        // eslint-disable-next-line no-await-in-loop
        await q(
          `INSERT INTO account_mappings (id, tenant_id, event_type, account_id, created_at, updated_at)
           SELECT gen_random_uuid(), :tenantId, 'sale_retention_guarantee', a.id, NOW(), NOW()
             FROM chart_of_accounts a
            WHERE a.tenant_id = :tenantId AND a.code = '130595'
              AND NOT EXISTS (SELECT 1 FROM account_mappings WHERE tenant_id = :tenantId AND event_type = 'sale_retention_guarantee')`,
          { tenantId },
        );
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DELETE FROM account_mappings WHERE event_type = 'sale_retention_guarantee'`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS project_cut_id`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS retention_released_at`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS retention_guarantee_amount`);
    await q(`DROP TABLE IF EXISTS project_cut_items`);
    await q(`DROP TABLE IF EXISTS project_cuts`);
    await q(`ALTER TABLE customer_advances DROP COLUMN IF EXISTS project_id`);
    await q(`ALTER TABLE projects DROP COLUMN IF EXISTS retention_released_at`);
    await q(`ALTER TABLE projects DROP COLUMN IF EXISTS retention_pct`);
  },
};
