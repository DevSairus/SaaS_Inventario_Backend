'use strict';

// Combos: agrupación de productos/servicios que se cargan de una vez en una
// factura, cotización u orden de trabajo. Tenant-scoped (sin `schema:`
// option): igual que physical_counts, se aplica a `public` (tenants legacy) y
// a cada schema de tenant vía provisionTenantSchema/migrateAllTenantSchemas.
//
// En los documentos el combo NO es una línea propia: se guardan sus
// componentes como líneas normales (así inventario, contabilidad e impuestos
// no cambian) y se agrupan con combo_group_id. combo_show_breakdown decide si
// en pantalla/PDF/DIAN se muestran los componentes o solo nombre + total.
//
// OJO: provisionTenantSchema.js corre esto con un pool de UNA sola conexión --
// SQL crudo con { transaction } e IF NOT EXISTS.
module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS combos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          name VARCHAR(200) NOT NULL,
          description TEXT,
          show_breakdown BOOLEAN NOT NULL DEFAULT true,
          is_active BOOLEAN NOT NULL DEFAULT true,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS combos_tenant_active_idx ON combos (tenant_id, is_active);`,
        { transaction }
      );

      // products es tabla de TENANT -- sin calificar schema (search_path).
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS combo_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          combo_id UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
          product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          quantity DECIMAL(10,3) NOT NULL DEFAULT 1,
          unit_price DECIMAL(15,2) NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS combo_items_combo_idx ON combo_items (combo_id);`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS combo_items_product_idx ON combo_items (product_id);`,
        { transaction }
      );

      // Columnas de agrupación en las líneas de documentos. combo_id queda
      // SET NULL si se borra el combo: el documento conserva el snapshot
      // (combo_name / combo_show_breakdown / combo_quantity).
      for (const table of ['sale_items', 'work_order_items']) {
        await queryInterface.sequelize.query(`
          ALTER TABLE ${table}
            ADD COLUMN IF NOT EXISTS combo_id UUID REFERENCES combos(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS combo_group_id UUID,
            ADD COLUMN IF NOT EXISTS combo_name VARCHAR(200),
            ADD COLUMN IF NOT EXISTS combo_quantity DECIMAL(10,3),
            ADD COLUMN IF NOT EXISTS combo_show_breakdown BOOLEAN;
        `, { transaction });
        await queryInterface.sequelize.query(
          `CREATE INDEX IF NOT EXISTS ${table}_combo_group_idx ON ${table} (combo_group_id);`,
          { transaction }
        );
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    for (const table of ['sale_items', 'work_order_items']) {
      await queryInterface.sequelize.query(`
        ALTER TABLE ${table}
          DROP COLUMN IF EXISTS combo_id,
          DROP COLUMN IF EXISTS combo_group_id,
          DROP COLUMN IF EXISTS combo_name,
          DROP COLUMN IF EXISTS combo_quantity,
          DROP COLUMN IF EXISTS combo_show_breakdown;
      `);
    }
    await queryInterface.dropTable('combo_items');
    await queryInterface.dropTable('combos');
  },
};
