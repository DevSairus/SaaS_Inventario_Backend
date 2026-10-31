'use strict';

// Ajustes de precio de venta (ver services/inventory/priceAdjustment.service.js).
// Cambian SOLO products.base_price: no tocan stock, costo promedio, último
// costo de compra ni contabilidad. Sirven para corregir el precio rápido (por
// ejemplo, con el costo de una compra que todavía no se ha registrado) dejando
// rastro de quién, cuándo, por qué y con qué costo de referencia.
//
//   price_adjustments: el documento AJP-000001 (motivo obligatorio).
//   price_adjustment_items: una línea por producto con el precio anterior y
//     el nuevo, el costo de referencia y su origen, el margen y el método con
//     que se calculó el sugerido, y una foto de los costos del producto en ese
//     momento. Si en el ajuste se cambió el margen del producto, margin_changed
//     queda en true y previous_margin_pct guarda el que tenía. sku/product_name se copian para que el historial siga legible
//     si el producto se borra.
//
// Sin calificar con esquema (salvo tenants/users, que viven en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS price_adjustments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          adjustment_number VARCHAR(30) NOT NULL,
          reason VARCHAR(255) NOT NULL CHECK (TRIM(reason) <> ''),
          notes TEXT,
          items_count INTEGER NOT NULL DEFAULT 0,
          created_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          UNIQUE (tenant_id, adjustment_number)
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS price_adjustments_created_idx ON price_adjustments (tenant_id, created_at DESC)`,
        { transaction }
      );

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS price_adjustment_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          adjustment_id UUID NOT NULL REFERENCES price_adjustments(id) ON DELETE CASCADE ON UPDATE CASCADE,
          product_id UUID REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
          sku VARCHAR(100),
          product_name VARCHAR(255),
          previous_price DECIMAL(15, 2) NOT NULL,
          new_price DECIMAL(15, 2) NOT NULL CHECK (new_price > 0),
          -- Costo con que se calculó el sugerido: el último de compra, el
          -- promedio o uno escrito a mano (cost_source = 'manual').
          reference_cost DECIMAL(15, 2),
          cost_source VARCHAR(20) CHECK (cost_source IN ('last_purchase', 'average', 'manual')),
          margin_pct DECIMAL(6, 2),
          previous_margin_pct DECIMAL(6, 2),
          margin_changed BOOLEAN NOT NULL DEFAULT false,
          margin_method VARCHAR(20),
          suggested_price DECIMAL(15, 2),
          price_includes_tax BOOLEAN NOT NULL DEFAULT false,
          -- Foto de los costos del producto al ajustar (no se modifican).
          last_purchase_cost DECIMAL(15, 2),
          average_cost DECIMAL(15, 2),
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS price_adjustment_items_adjustment_idx ON price_adjustment_items (adjustment_id)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS price_adjustment_items_product_idx ON price_adjustment_items (tenant_id, product_id, created_at DESC)`,
        { transaction }
      );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS price_adjustment_items`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS price_adjustments`);
  },
};
