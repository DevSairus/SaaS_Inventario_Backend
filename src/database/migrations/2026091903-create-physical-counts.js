'use strict';

// Tablas del "Inventario físico (conteo por Excel)". Tenant-scoped (sin
// `schema:` option): igual que product_equivalence_groups, se aplican tanto a
// `public` (tenants legacy) como a cada schema de tenant vía
// provisionTenantSchema/migrateAllTenantSchemas -- ver esos scripts.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS physical_counts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          count_number VARCHAR(50) NOT NULL,
          warehouse_id UUID,
          category_id UUID,
          include_inactive BOOLEAN NOT NULL DEFAULT false,
          status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'cancelled')),
          generated_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          applied_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          applied_at TIMESTAMP WITH TIME ZONE,
          entry_adjustment_id UUID REFERENCES inventory_adjustments(id) ON DELETE SET NULL,
          exit_adjustment_id UUID REFERENCES inventory_adjustments(id) ON DELETE SET NULL,
          notes TEXT,
          total_products INTEGER NOT NULL DEFAULT 0,
          counted_products INTEGER NOT NULL DEFAULT 0,
          not_counted_products INTEGER NOT NULL DEFAULT 0,
          conflict_products INTEGER NOT NULL DEFAULT 0,
          error_rows INTEGER NOT NULL DEFAULT 0,
          surplus_products INTEGER NOT NULL DEFAULT 0,
          surplus_qty DECIMAL(15,2) NOT NULL DEFAULT 0,
          surplus_value DECIMAL(15,2) NOT NULL DEFAULT 0,
          shortage_products INTEGER NOT NULL DEFAULT 0,
          shortage_qty DECIMAL(15,2) NOT NULL DEFAULT 0,
          shortage_value DECIMAL(15,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS physical_counts_tenant_number_unique
        ON physical_counts (tenant_id, count_number);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS physical_counts_tenant_idx ON physical_counts (tenant_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS physical_counts_status_idx ON physical_counts (status);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS physical_counts_warehouse_idx ON physical_counts (warehouse_id);
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS physical_count_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          count_id UUID NOT NULL REFERENCES physical_counts(id) ON DELETE CASCADE,
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          product_sku VARCHAR(50),
          product_name VARCHAR(200),
          system_qty DECIMAL(15,2) NOT NULL DEFAULT 0,
          counted_qty DECIMAL(15,2),
          diff_qty DECIMAL(15,2),
          unit_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
          has_conflict BOOLEAN NOT NULL DEFAULT false,
          applied BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS physical_count_items_count_idx ON physical_count_items (count_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS physical_count_items_product_idx ON physical_count_items (product_id);
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS physical_count_items_tenant_idx ON physical_count_items (tenant_id);
      `, { transaction });

      // inventory_adjustments.physical_count_id -- enlaza el ajuste (entrada o
      // salida) con la sesión de conteo que lo generó. addColumn no respeta
      // search_path (ver provisionTenantSchema.js), por eso ALTER TABLE crudo.
      await queryInterface.sequelize.query(`
        ALTER TABLE inventory_adjustments
        ADD COLUMN IF NOT EXISTS physical_count_id UUID REFERENCES physical_counts(id) ON DELETE SET NULL;
      `, { transaction });
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS inventory_adjustments_physical_count_idx
        ON inventory_adjustments (physical_count_id);
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE inventory_adjustments DROP COLUMN IF EXISTS physical_count_id;`);
    await queryInterface.dropTable('physical_count_items');
    await queryInterface.dropTable('physical_counts');
  },
};
