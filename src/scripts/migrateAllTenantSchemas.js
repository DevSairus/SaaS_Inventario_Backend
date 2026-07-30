// src/scripts/migrateAllTenantSchemas.js
//
// Uso manual: node src/scripts/migrateAllTenantSchemas.js
// También se corre automáticamente al arrancar el servidor (ver server.js),
// justo después de runMigrations().
//
// Por qué hace falta: runMigrations() (src/database/migrator.js) solo corre
// las migraciones pendientes contra `public` -- eso mantiene a `public` (y a
// los tenants todavía en modo legado, que viven ahí) al día, pero un tenant
// ya cortado a su propio schema queda congelado en el estado que tenía en el
// momento del corte. Cada migración nueva que se agregue después del corte
// queda "huérfana" para ese tenant: nunca se aplica, así que su schema se
// desalinea cada vez más de lo que el código espera (columna faltante, tabla
// faltante) -- mientras más tenants se corten, más migraciones huérfanas se
// acumulan. Sin este paso, completar el resto de la migración no alcanza:
// cada release nueva vuelve a desalinear a los tenants ya migrados.
//
// provisionTenantSchema.js YA sabe correr el set completo de migraciones
// DENTRO de un schema dado, de forma idempotente (usa Umzug con su propia
// tabla `sequelize_migrations` POR SCHEMA -- correrlo de nuevo sobre un
// schema que ya existe solo aplica lo que le falte). Este script reutiliza
// esa misma función para cada tenant ya cortado, en vez de duplicar la
// lógica de conexión/search_path/orden de migraciones que ya resolvió
// provisionTenantSchema.js (incluyendo el SORT_KEY_OVERRIDES de los dos
// archivos de migración mal nombrados).
require('dotenv').config();
const { sequelize } = require('../config/database');
const { provisionTenantSchema } = require('./provisionTenantSchema');

async function migrateAllTenantSchemas() {
  const [tenants] = await sequelize.query(
    `SELECT slug, schema_name FROM public.tenants WHERE schema_name IS NOT NULL ORDER BY slug ASC`
  );

  const results = { total: tenants.length, ok: [], failed: [] };

  for (const t of tenants) {
    try {
      await provisionTenantSchema(t.slug);
      results.ok.push(t.slug);
    } catch (err) {
      results.failed.push({ slug: t.slug, schema: t.schema_name, error: err.message });
      console.error(`[migrateAllTenantSchemas] Error migrando schema de "${t.slug}" (${t.schema_name}):`, err.message);
    }
  }

  return results;
}

if (require.main === module) {
  migrateAllTenantSchemas()
    .then((results) => {
      console.log(`✅ ${results.ok.length}/${results.total} schemas de tenant al día. Fallidos: ${results.failed.length}`);
      if (results.failed.length > 0) console.log(JSON.stringify(results.failed, null, 2));
      process.exit(results.failed.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('❌ Error corriendo migrateAllTenantSchemas:', err);
      process.exit(1);
    });
}

module.exports = { migrateAllTenantSchemas };
