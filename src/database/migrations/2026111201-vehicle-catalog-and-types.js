'use strict';

// Catálogo global de marcas/líneas de vehículos + tipos nuevos.
//   1. public.vehicle_catalog_brands / public.vehicle_catalog_lines (una sola
//      copia para todas las empresas) y su carga desde data/vehicleCatalog.json.
//      La carga corre una vez, en public; ON CONFLICT la hace repetible.
//   2. Tipos de vehículo motocarro, cuatrimoto (ATV) y utv en el enum de
//      vehicles.vehicle_type del schema en curso (cada schema de empresa
//      tiene su propio tipo enum).
// Corre en public y luego en cada schema de empresa (migrateAllTenantSchemas).
const NEW_TYPES = ['motocarro', 'cuatrimoto', 'utv'];

module.exports = {
  up: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const q = (sql, opts) => sequelize.query(sql, opts);

    await q(`
      CREATE TABLE IF NOT EXISTS public.vehicle_catalog_brands (
        id SERIAL PRIMARY KEY,
        name VARCHAR(80) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await q(`
      CREATE TABLE IF NOT EXISTS public.vehicle_catalog_lines (
        id SERIAL PRIMARY KEY,
        brand_id INTEGER NOT NULL REFERENCES public.vehicle_catalog_brands(id) ON DELETE CASCADE,
        vehicle_class VARCHAR(20) NOT NULL
          CHECK (vehicle_class IN ('liviano', 'pesado', 'moto', 'motocarro', 'cuatrimoto', 'utv')),
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (brand_id, vehicle_class, name)
      )
    `);
    await q(`CREATE INDEX IF NOT EXISTS vehicle_catalog_lines_class_idx ON public.vehicle_catalog_lines (vehicle_class, brand_id)`);

    const [[{ schema }]] = await q(`SELECT current_schema() AS schema`);
    const [[{ n }]] = await q(`SELECT COUNT(*)::int AS n FROM public.vehicle_catalog_lines`);
    if (schema === 'public' || n === 0) {
      const { seedVehicleCatalog } = require('../../services/workshop/vehicleCatalog.service');
      await seedVehicleCatalog(sequelize);
    }

    // Enum de vehicles.vehicle_type en el schema en curso (si la tabla existe).
    const [enums] = await q(`
      SELECT tn.nspname AS ns, t.typname AS typ
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid AND c.relname = 'vehicles'
        JOIN pg_namespace cn ON cn.oid = c.relnamespace AND cn.nspname = current_schema()
        JOIN pg_type t ON t.oid = a.atttypid AND t.typtype = 'e'
        JOIN pg_namespace tn ON tn.oid = t.typnamespace
       WHERE a.attname = 'vehicle_type' AND NOT a.attisdropped
    `);
    for (const { ns, typ } of enums) {
      for (const value of NEW_TYPES) {
        await q(`ALTER TYPE "${ns}"."${typ}" ADD VALUE IF NOT EXISTS '${value}' BEFORE 'camion'`);
      }
    }
  },

  // Postgres no permite quitar valores de un enum; solo se retira el catálogo.
  down: async (queryInterface) => {
    const [[{ schema }]] = await queryInterface.sequelize.query(`SELECT current_schema() AS schema`);
    if (schema !== 'public') return;
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS public.vehicle_catalog_lines`);
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS public.vehicle_catalog_brands`);
  },
};
