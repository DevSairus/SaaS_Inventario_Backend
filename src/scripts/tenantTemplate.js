// src/scripts/tenantTemplate.js
//
// Uso manual: node src/scripts/tenantTemplate.js
// También corre al arrancar el servidor, dentro de migrateAllTenantSchemas.
//
// Schema plantilla para crear tenants nuevos por clonación
// (cloneTenantSchema.js) en vez de correr todas las migraciones. Se mantiene
// al día con el mismo runner de migraciones que los tenants
// (_schemaMigrations.js), así que su estructura es exactamente la de un
// tenant recién aprovisionado.
//
// No lleva el prefijo "tenant_" para que nunca aparezca como un tenant
// (listados por nspname LIKE 'tenant_%', schemaNameFor de un slug, etc.).
//
// Las migraciones de siembra por tenant (sede principal, plan de cuentas,
// fondos de nómina...) reciben un tenantId que no existe en public.tenants:
// todas filtran por context.tenantId, así que en la plantilla no siembran
// nada. Igual no importaría para la estructura -- el clon solo copia filas
// globales (tenant_id NULL) y migrateTenantData repone los datos reales.

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { directDbDialectOptions } = require('./_directDbSsl');
const { DATABASE_URL, listMigrationFiles, runMigrationsInSchema } = require('./_schemaMigrations');

const TEMPLATE_SCHEMA = 'pitbox_template';
const TEMPLATE_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function directSequelize() {
  return new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: directDbDialectOptions(DATABASE_URL),
    logging: false,
    pool: { max: 1, min: 0 },
  });
}

/**
 * ¿La plantilla existe y tiene aplicadas TODAS las migraciones del código?
 * Justo después de un deploy con migraciones nuevas, y hasta que el
 * arranque la ponga al día, responde ready=false y el aprovisionamiento usa
 * el camino de migraciones.
 */
async function templateStatus(sequelize) {
  const [[{ ok }]] = await sequelize.query(
    'SELECT to_regclass(:t) IS NOT NULL AS ok',
    { replacements: { t: `"${TEMPLATE_SCHEMA}".sequelize_migrations` } }
  );
  if (!ok) return { ready: false, reason: `la plantilla "${TEMPLATE_SCHEMA}" todavía no existe` };

  const [rows] = await sequelize.query(`SELECT name FROM "${TEMPLATE_SCHEMA}".sequelize_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  const missing = listMigrationFiles().filter((f) => !applied.has(f));
  if (missing.length) {
    return { ready: false, reason: `a la plantilla le faltan ${missing.length} migraciones (ej. ${missing[0]})` };
  }
  return { ready: true };
}

/** Crea la plantilla si no existe y le aplica las migraciones pendientes. */
async function ensureTenantTemplate() {
  const bootstrap = directSequelize();
  try {
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${TEMPLATE_SCHEMA}"`);
  } finally {
    await bootstrap.close();
  }

  const executed = await runMigrationsInSchema(TEMPLATE_SCHEMA, {
    tenantId: TEMPLATE_TENANT_ID,
    schemaName: TEMPLATE_SCHEMA,
    slug: null,
  });

  // Visibilidad: si alguna migración futura siembra filas de tenants sin
  // respetar context.tenantId, que se note en el log (no rompe el clon:
  // esas filas no se copian).
  const check = directSequelize();
  try {
    const [tables] = await check.query(`
      SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = :schema AND c.relkind = 'r'
    `, { replacements: { schema: TEMPLATE_SCHEMA } });
    const dirty = [];
    for (const { name } of tables) {
      const [[{ n }]] = await check.query(`SELECT count(*)::int AS n FROM "${TEMPLATE_SCHEMA}"."${name}" WHERE tenant_id IS NOT NULL`);
      if (n) dirty.push(`${name}=${n}`);
    }
    if (dirty.length) {
      console.warn(`[tenantTemplate] La plantilla tiene filas de tenants (no se copian al clonar): ${dirty.join(', ')}`);
    }
  } finally {
    await check.close();
  }

  return executed;
}

if (require.main === module) {
  ensureTenantTemplate()
    .then((executed) => {
      console.log(`✅ Plantilla "${TEMPLATE_SCHEMA}" al día (${executed.length} migraciones aplicadas en esta corrida)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Error preparando la plantilla:', err);
      process.exit(1);
    });
}

module.exports = { TEMPLATE_SCHEMA, TEMPLATE_TENANT_ID, templateStatus, ensureTenantTemplate, directSequelize };
