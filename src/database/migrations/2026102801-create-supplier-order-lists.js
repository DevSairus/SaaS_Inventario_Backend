'use strict';

// Listas de pedido a proveedor (ver controllers/inventory/orderLists.controller.js).
// No es una orden de compra: no lleva precios ni contabilidad. Es la libreta
// donde se va anotando qué hay que pedirle a cada proveedor.
//
//   supplier_order_lists: una lista por proveedor. Solo puede haber UNA
//     abierta (status 'open') por proveedor (índice único parcial); al
//     marcarla pedida ('ordered') o descartarla ('cancelled') queda en el
//     historial y la siguiente anotación abre una nueva. purchase_id enlaza
//     la compra que se creó a partir de ella (opcional).
//   supplier_order_list_items: líneas. product_id NULL = línea libre (un
//     ítem que aún no existe en el catálogo, solo con descripción); para
//     convertir la lista en compra todas deben estar enlazadas a un producto.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS supplier_order_lists (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE ON UPDATE CASCADE,
          list_number VARCHAR(30) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'open'
            CHECK (status IN ('open', 'ordered', 'cancelled')),
          notes TEXT,

          ordered_at TIMESTAMP WITH TIME ZONE,
          ordered_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          cancelled_at TIMESTAMP WITH TIME ZONE,
          cancelled_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL ON UPDATE CASCADE,
          -- Envíos al proveedor: [{ date, channel: 'email'|'whatsapp'|'pdf', to, user_id }]
          sent_log JSONB NOT NULL DEFAULT '[]'::jsonb,

          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, list_number)
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS supplier_order_lists_one_open_idx
           ON supplier_order_lists (tenant_id, supplier_id) WHERE status = 'open'`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS supplier_order_lists_status_idx ON supplier_order_lists (tenant_id, status)`,
        { transaction }
      );

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS supplier_order_list_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          list_id UUID NOT NULL REFERENCES supplier_order_lists(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
          description VARCHAR(255),
          quantity DECIMAL(15, 2) NOT NULL CHECK (quantity > 0),
          notes TEXT,
          source VARCHAR(20) NOT NULL DEFAULT 'manual'
            CHECK (source IN ('manual', 'stock_alert', 'product')),
          added_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          CHECK (product_id IS NOT NULL OR COALESCE(TRIM(description), '') <> '')
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS supplier_order_list_items_list_idx ON supplier_order_list_items (list_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS supplier_order_list_items_product_idx ON supplier_order_list_items (tenant_id, product_id)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS supplier_order_list_items`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS supplier_order_lists`);
  },
};
