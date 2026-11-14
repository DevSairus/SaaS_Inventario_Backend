'use strict';

// 2.2 / 2.3 — Ubicación física en bodega (pasillo / estante / nivel).
//
//   - warehouse_locations: catálogo de ubicaciones por bodega, código único por
//     bodega (sin distinguir mayúsculas).
//   - products.location_id: ubicación del producto dentro de su bodega
//     (NULL = sin ubicación). ON DELETE SET NULL: borrar una ubicación deja
//     los productos sin ubicación, no los borra.
//   - physical_counts.location_id / include_subcategories y
//     physical_count_items.location_code: el conteo físico se puede generar por
//     ubicación y por familia de categorías (2.3), y guarda el código de la
//     ubicación de cada línea al generar la plantilla (los códigos cambian
//     después; el conteo conserva el que se imprimió).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant. to_regclass porque también corre en `public`.

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`
      DO $$ BEGIN
        IF to_regclass('warehouses') IS NOT NULL THEN
          CREATE TABLE IF NOT EXISTS warehouse_locations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
            warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE ON UPDATE CASCADE,
            code VARCHAR(40) NOT NULL,
            aisle VARCHAR(20),
            shelf VARCHAR(20),
            level VARCHAR(20),
            description VARCHAR(200),
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
          CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_locations_code ON warehouse_locations (warehouse_id, LOWER(code));
          CREATE INDEX IF NOT EXISTS idx_warehouse_locations_tenant ON warehouse_locations (tenant_id);
        END IF;
      END $$;
    `);

    await q(`
      DO $$ BEGIN
        IF to_regclass('products') IS NOT NULL AND to_regclass('warehouse_locations') IS NOT NULL THEN
          ALTER TABLE products ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES warehouse_locations(id) ON DELETE SET NULL ON UPDATE CASCADE;
          CREATE INDEX IF NOT EXISTS idx_products_location ON products (location_id) WHERE location_id IS NOT NULL;
        END IF;
      END $$;
    `);

    await q(`
      DO $$ BEGIN
        IF to_regclass('physical_counts') IS NOT NULL AND to_regclass('warehouse_locations') IS NOT NULL THEN
          ALTER TABLE physical_counts ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES warehouse_locations(id) ON DELETE SET NULL ON UPDATE CASCADE;
          ALTER TABLE physical_counts ADD COLUMN IF NOT EXISTS include_subcategories BOOLEAN NOT NULL DEFAULT TRUE;
        END IF;
        IF to_regclass('physical_count_items') IS NOT NULL THEN
          ALTER TABLE physical_count_items ADD COLUMN IF NOT EXISTS location_code VARCHAR(40);
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE IF EXISTS physical_count_items DROP COLUMN IF EXISTS location_code`);
    await q(`ALTER TABLE IF EXISTS physical_counts DROP COLUMN IF EXISTS include_subcategories`);
    await q(`ALTER TABLE IF EXISTS physical_counts DROP COLUMN IF EXISTS location_id`);
    await q(`DROP INDEX IF EXISTS idx_products_location`);
    await q(`ALTER TABLE IF EXISTS products DROP COLUMN IF EXISTS location_id`);
    await q(`DROP TABLE IF EXISTS warehouse_locations`);
  },
};
