// Catálogo global de marcas y líneas de vehículos del mercado colombiano
// (desde 1980): livianos, pesados, motos, motocarros, cuatrimotos y UTV.
// Vive en `public` (no es dato de la empresa) y se llena desde
// data/vehicleCatalog.json. Las consultas van calificadas con `public.`
// porque se hacen con el search_path del tenant activo.
const { QueryTypes } = require('sequelize');
const { CATALOG_CLASS_BY_TYPE, CATALOG_CLASSES } = require('../../constants/vehicleTypes');

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // clase -> { at, brands }

/**
 * Inserta las marcas y líneas del JSON que falten (no borra ni cambia las
 * existentes). Devuelve cuántas líneas nuevas quedaron.
 */
async function seedVehicleCatalog(sequelize, data = require('../../data/vehicleCatalog.json')) {
  const brands = data.brands || [];
  if (!brands.length) return 0;

  const brandParams = brands.map((b) => b.brand);
  await sequelize.query(
    `INSERT INTO public.vehicle_catalog_brands (name)
     SELECT unnest(ARRAY[:names]::text[])
     ON CONFLICT (name) DO NOTHING`,
    { replacements: { names: brandParams } },
  );

  const names = [];
  const classes = [];
  const lines = [];
  for (const b of brands) {
    for (const [cls, list] of Object.entries(b.lines || {})) {
      if (!CATALOG_CLASSES.includes(cls)) continue;
      for (const line of list) {
        names.push(b.brand);
        classes.push(cls);
        lines.push(line);
      }
    }
  }
  const [, inserted] = await sequelize.query(
    `INSERT INTO public.vehicle_catalog_lines (brand_id, vehicle_class, name)
     SELECT vb.id, x.cls, x.line
       FROM unnest(ARRAY[:names]::text[], ARRAY[:classes]::text[], ARRAY[:lines]::text[]) AS x(brand, cls, line)
       JOIN public.vehicle_catalog_brands vb ON vb.name = x.brand
     ON CONFLICT (brand_id, vehicle_class, name) DO NOTHING`,
    { replacements: { names, classes, lines } },
  );
  cache.clear();
  return typeof inserted === 'number' ? inserted : (inserted?.rowCount ?? 0);
}

/** Marcas con sus líneas para una clase del catálogo: [{ brand, lines: [] }]. */
async function catalogForClass(sequelize, cls) {
  if (!CATALOG_CLASSES.includes(cls)) return [];
  const hit = cache.get(cls);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.brands;

  const rows = await sequelize.query(
    `SELECT vb.name AS brand, array_agg(vl.name ORDER BY vl.name) AS lines
       FROM public.vehicle_catalog_lines vl
       JOIN public.vehicle_catalog_brands vb ON vb.id = vl.brand_id
      WHERE vl.vehicle_class = :cls AND vl.is_active
      GROUP BY vb.name
      ORDER BY vb.name`,
    { replacements: { cls }, type: QueryTypes.SELECT },
  );
  const brands = rows.map((r) => ({ brand: r.brand, lines: r.lines || [] }));
  cache.set(cls, { at: Date.now(), brands });
  return brands;
}

/** Catálogo para un tipo de vehículo (automovil, motocicleta, …). */
async function catalogForVehicleType(sequelize, vehicleType) {
  const cls = CATALOG_CLASS_BY_TYPE[vehicleType];
  return cls ? catalogForClass(sequelize, cls) : [];
}

module.exports = { seedVehicleCatalog, catalogForClass, catalogForVehicleType };
