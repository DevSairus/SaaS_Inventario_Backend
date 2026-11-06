// src/scripts/provisionTenantSchema.js
//
// Uso: node src/scripts/provisionTenantSchema.js <tenant_slug>
//
// 1. Si el schema `tenant_<slug>` todavía no tiene tablas y la plantilla
//    (tenantTemplate.js) está al día, lo crea CLONANDO la plantilla
//    (cloneTenantSchema.js): segundos en vez de minutos.
// 2. Si no se pudo clonar (plantilla inexistente/desactualizada, objeto que
//    el clonador no sabe copiar, verificación fallida), crea el schema vacío
//    y sigue por el camino de siempre.
// 3. En ambos casos corre las migraciones DENTRO de ese schema (vía
//    search_path) -- tras un clon no debería quedar ninguna pendiente; sobre
//    un schema existente solo aplica lo que le falte.
// 4. El schema queda con la estructura actual, VACÍO de datos del tenant
//    (el copiado de datos es un paso aparte -> migrateTenantData.js).

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { directDbDialectOptions } = require('./_directDbSsl');
const { DATABASE_URL, runMigrationsInSchema } = require('./_schemaMigrations');
const { cloneTenantSchema } = require('./cloneTenantSchema');
const { TEMPLATE_SCHEMA, templateStatus } = require('./tenantTemplate');

function schemaNameFor(slug) {
  return `tenant_${slug.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/**
 * @returns {Promise<{schemaName: string, cloned: boolean}>}
 *   cloned=true: el schema se creó en esta llamada a partir de la plantilla
 *   y no tiene filas de tenant (migrateTenantData puede saltarse su limpieza).
 */
async function provisionTenantSchemaDetailed(slug) {
  const schemaName = schemaNameFor(slug);

  // Conexión aparte y de un solo uso, con search_path por defecto (public).
  const bootstrapSequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: directDbDialectOptions(DATABASE_URL),
    logging: false,
    pool: { max: 1, min: 0 },
  });
  let tenantId;
  let cloned = false;
  try {
    // Necesario para que las migraciones de backfill (sede principal,
    // asignación usuario-sede, etc.) puedan filtrar por ESTE tenant y no
    // arrastren filas de todos los tenants existentes en public.tenants.
    const [[tenant]] = await bootstrapSequelize.query(
      `SELECT id FROM public.tenants WHERE slug = :slug`,
      { replacements: { slug } }
    );
    if (!tenant) throw new Error(`Tenant "${slug}" no existe en public.tenants`);
    tenantId = tenant.id;

    const [[{ count: existingTables }]] = await bootstrapSequelize.query(
      `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = :schemaName`,
      { replacements: { schemaName } }
    );

    if (existingTables === 0) {
      const status = await templateStatus(bootstrapSequelize);
      if (!status.ready) {
        console.log(`ℹ️  No se clona "${schemaName}": ${status.reason}. Se usan las migraciones.`);
      } else {
        try {
          const { tables, ms } = await cloneTenantSchema(bootstrapSequelize, TEMPLATE_SCHEMA, schemaName);
          cloned = true;
          console.log(`✅ Schema "${schemaName}" clonado de "${TEMPLATE_SCHEMA}" (${tables} tablas, ${ms} ms)`);
        } catch (err) {
          // La transacción del clon se revirtió entera: el schema queda como
          // estaba y se sigue por el camino de migraciones.
          console.warn(`⚠️  No se pudo clonar "${schemaName}" desde la plantilla, se usan las migraciones: ${err.message}`);
        }
      }
    }

    if (!cloned) {
      await bootstrapSequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
      console.log(`✅ Schema "${schemaName}" listo`);
    }
  } finally {
    await bootstrapSequelize.close();
  }

  await runMigrationsInSchema(schemaName, { tenantId, schemaName, slug });

  return { schemaName, cloned };
}

async function provisionTenantSchema(slug) {
  const { schemaName } = await provisionTenantSchemaDetailed(slug);
  return schemaName;
}

if (require.main === module) {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Uso: node provisionTenantSchema.js <tenant_slug>');
    process.exit(1);
  }
  provisionTenantSchema(slug)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error aprovisionando schema:', err);
      process.exit(1);
    });
}

module.exports = { provisionTenantSchema, provisionTenantSchemaDetailed, schemaNameFor };
