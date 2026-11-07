'use strict';

// Módulo Proyectos, Fase 1 (ver 00 - Documentación/Modulo_Proyectos_Solar_
// Pitbox_Analisis.md §4.3). Todo aditivo: tablas nuevas y columnas nullables;
// con project_id NULL cada documento funciona exactamente como antes.
//
//   projects: la obra. code PRY-0001 por tenant; warehouse_id es su bodega
//     (una bodega normal con warehouses.project_id apuntando de vuelta).
//   project_budget_lines: presupuesto por categoría (materiales, mano de
//     obra, servicios/subcontratos, otros).
//   project_bom_items: lista de materiales pegada desde Excel. qty_reserved
//     es lo apartado del stock y todavía no despachado (no toca
//     products.reserved_stock: se suma al "en trámite" que se calcula al leer,
//     ver services/inventory/stockInProcess.service.js); qty_dispatched lo que
//     ya salió hacia la bodega del proyecto; qty_ordered lo anotado en pedidos
//     a proveedor.
//
// Columnas project_id en bodegas, compras, gastos, ventas, traslados y
// pedidos a proveedor. Los pedidos de un proyecto van aparte de los
// generales: la regla "una lista abierta por proveedor" pasa a ser por
// proveedor y proyecto.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          branch_id UUID REFERENCES branches(id) ON DELETE SET NULL ON UPDATE CASCADE,
          code VARCHAR(30) NOT NULL,
          name VARCHAR(200) NOT NULL,
          customer_id UUID REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,
          quote_id UUID REFERENCES sales(id) ON DELETE SET NULL ON UPDATE CASCADE,
          type VARCHAR(30) NOT NULL DEFAULT 'otro'
            CHECK (type IN ('residencial', 'comercial', 'industrial', 'ongrid', 'offgrid', 'otro')),
          status VARCHAR(20) NOT NULL DEFAULT 'prospect'
            CHECK (status IN ('prospect', 'quoted', 'approved', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled')),
          site_address TEXT,
          city VARCHAR(100),
          capacity_kwp DECIMAL(12, 3),
          start_date DATE,
          end_date_planned DATE,
          end_date_actual DATE,
          manager_id UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL ON UPDATE CASCADE,
          contract_amount DECIMAL(15, 2),
          notes TEXT,
          closed_at TIMESTAMP WITH TIME ZONE,
          closed_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, code)
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (tenant_id, status)`);
      await q(`CREATE INDEX IF NOT EXISTS projects_customer_idx ON projects (customer_id)`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_budget_lines (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          category VARCHAR(20) NOT NULL
            CHECK (category IN ('materials', 'labor', 'services', 'other')),
          description VARCHAR(255) NOT NULL,
          product_id UUID REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
          quantity DECIMAL(15, 4),
          unit_cost DECIMAL(15, 2),
          budget_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
          source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bom', 'quote')),
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS project_budget_lines_project_idx ON project_budget_lines (project_id)`);

      await q(`
        CREATE TABLE IF NOT EXISTS project_bom_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
          line_no INTEGER NOT NULL,
          input_code VARCHAR(100),
          input_description VARCHAR(255),
          unit VARCHAR(30),
          product_id UUID REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
          match_status VARCHAR(20) NOT NULL DEFAULT 'unmatched'
            CHECK (match_status IN ('matched', 'manual', 'ambiguous', 'unmatched')),
          qty_required DECIMAL(15, 4) NOT NULL CHECK (qty_required > 0),
          qty_reserved DECIMAL(15, 4) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
          qty_dispatched DECIMAL(15, 4) NOT NULL DEFAULT 0 CHECK (qty_dispatched >= 0),
          qty_ordered DECIMAL(15, 4) NOT NULL DEFAULT 0 CHECK (qty_ordered >= 0),
          budget_unit_cost DECIMAL(15, 2),
          notes TEXT,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          CHECK (product_id IS NOT NULL OR COALESCE(TRIM(input_code), '') <> '' OR COALESCE(TRIM(input_description), '') <> '')
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS project_bom_items_project_idx ON project_bom_items (project_id, line_no)`);
      // "En trámite": reservas vivas por producto.
      await q(`CREATE INDEX IF NOT EXISTS project_bom_items_reserved_idx ON project_bom_items (product_id) WHERE qty_reserved > 0`);

      // ── project_id en documentos existentes ───────────────────────────
      for (const table of ['warehouses', 'purchases', 'expenses', 'sales', 'transfers', 'supplier_order_lists']) {
        await q(`ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL ON UPDATE CASCADE`);
        await q(`CREATE INDEX IF NOT EXISTS ${table}_project_idx ON ${table} (project_id) WHERE project_id IS NOT NULL`);
      }
      // Despacho de materiales del BOM: cada línea del traslado sabe de qué
      // línea del BOM salió (para devolverla si el traslado se cancela).
      await q(`ALTER TABLE IF EXISTS transfer_items ADD COLUMN IF NOT EXISTS project_bom_item_id UUID REFERENCES project_bom_items(id) ON DELETE SET NULL ON UPDATE CASCADE`);

      // Una lista abierta por proveedor Y proyecto (NULL = pedido general).
      await q(`DROP INDEX IF EXISTS supplier_order_lists_one_open_idx`);
      await q(`
        CREATE UNIQUE INDEX IF NOT EXISTS supplier_order_lists_one_open_idx
          ON supplier_order_lists (tenant_id, supplier_id, COALESCE(project_id, '${ZERO_UUID}'::uuid))
          WHERE status = 'open'
      `);

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS supplier_order_lists_one_open_idx`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS supplier_order_lists_one_open_idx ON supplier_order_lists (tenant_id, supplier_id) WHERE status = 'open'`);
    await q(`ALTER TABLE IF EXISTS transfer_items DROP COLUMN IF EXISTS project_bom_item_id`);
    for (const table of ['warehouses', 'purchases', 'expenses', 'sales', 'transfers', 'supplier_order_lists']) {
      await q(`ALTER TABLE IF EXISTS ${table} DROP COLUMN IF EXISTS project_id`);
    }
    await q(`DROP TABLE IF EXISTS project_bom_items`);
    await q(`DROP TABLE IF EXISTS project_budget_lines`);
    await q(`DROP TABLE IF EXISTS projects`);
  },
};
