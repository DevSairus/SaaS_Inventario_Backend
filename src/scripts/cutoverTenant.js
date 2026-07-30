// src/scripts/cutoverTenant.js
//
// Uso: node src/scripts/cutoverTenant.js <tenant_slug>
//
// Orquesta el corte completo de UN tenant, con checkpoints:
//   1. Provisiona el schema (crea + corre migraciones)
//   2. Copia y verifica los datos (public -> schema nuevo)
//   3. SOLO SI (1) y (2) pasan sin error: setea tenants.schema_name
//      -> a partir de la siguiente request de ese tenant, el middleware
//         lo enruta automáticamente al schema nuevo.
//
// Las filas viejas en `public` NO se borran aquí a propósito. Déjalas
// como respaldo unos días y bórralas en un paso separado y consciente
// (drop de columnas/rows) una vez confirmes que todo quedó bien en
// producción real, no solo en el reporte de conteos.

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { provisionTenantSchema } = require('./provisionTenantSchema');
const { migrateTenantData } = require('./migrateTenantData');
const { directDbDialectOptions } = require('./_directDbSsl');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function cutoverTenant(slug) {
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: directDbDialectOptions(DATABASE_URL),
    logging: false,
  });

  try {
    const [[tenant]] = await sequelize.query(
      `SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug`,
      { replacements: { slug } }
    );
    if (!tenant) throw new Error(`Tenant "${slug}" no existe`);
    if (tenant.schema_name) {
      console.log(`⚠️  Tenant "${slug}" ya tiene schema_name="${tenant.schema_name}". Nada que hacer.`);
      return;
    }

    console.log(`\n=== 1/3 Aprovisionando schema para "${slug}" ===`);
    const schemaName = await provisionTenantSchema(slug);

    console.log(`\n=== 2/3 Copiando y verificando datos ===`);
    await migrateTenantData(slug, tenant.id);

    console.log(`\n=== 3/3 Activando corte (schema_name) ===`);
    await sequelize.query(
      `UPDATE public.tenants SET schema_name = :schemaName WHERE id = :tenantId`,
      { replacements: { schemaName, tenantId: tenant.id } }
    );

    console.log(`\n✅ Tenant "${slug}" migrado y activo en "${schemaName}"`);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Uso: node cutoverTenant.js <tenant_slug>');
    process.exit(1);
  }
  cutoverTenant(slug)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error en cutover:', err);
      process.exit(1);
    });
}

module.exports = { cutoverTenant };