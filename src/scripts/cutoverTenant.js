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
const { provisionTenantSchemaDetailed } = require('./provisionTenantSchema');
const { migrateTenantData } = require('./migrateTenantData');
const { directDbDialectOptions } = require('./_directDbSsl');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function cutoverTenant(slug) {
  // pool de UNA conexión: el advisory lock de abajo es de sesión, así que el
  // lock, todas las queries de este script y el unlock tienen que ir por la
  // misma conexión física.
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: directDbDialectOptions(DATABASE_URL),
    logging: false,
    pool: { max: 1, min: 1 },
  });

  let locked = false;
  try {
    // Dos cortes simultáneos del mismo tenant (ej. el panel daba timeout a
    // los 30s y se apretaba "Reintentar" mientras el primero seguía) corren
    // las mismas migraciones en paralelo sobre el schema y chocan con
    // "relation ... already exists". El lock se libera solo si el proceso muere.
    const [[{ ok }]] = await sequelize.query(
      `SELECT pg_try_advisory_lock(hashtext(:key)) AS ok`,
      { replacements: { key: `cutover:${slug}` } }
    );
    if (!ok) {
      const err = new Error(`Ya hay un cutover en curso para "${slug}". Espera a que termine antes de reintentar.`);
      err.code = 'CUTOVER_IN_PROGRESS';
      throw err;
    }
    locked = true;

    const [[tenant]] = await sequelize.query(
      `SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug`,
      { replacements: { slug } }
    );
    if (!tenant) throw new Error(`Tenant "${slug}" no existe`);
    if (tenant.schema_name) {
      console.log(`⚠️  Tenant "${slug}" ya tiene schema_name="${tenant.schema_name}". Nada que hacer.`);
      return;
    }

    // 'running' para que el panel muestre "En curso" y no ofrezca lanzar otro
    // corte: tarda minutos (cientos de migraciones contra Neon).
    await sequelize.query(
      `UPDATE public.tenants
       SET cutover_last_status = 'running', cutover_last_error = NULL, cutover_last_attempt_at = NOW()
       WHERE id = :tenantId`,
      { replacements: { tenantId: tenant.id } }
    );

    try {
      await runCutoverSteps(sequelize, slug, tenant);
    } catch (err) {
      // Se registra acá (no solo en las rutas) para que un corte por consola
      // que falla no deje el tenant en 'running' para siempre.
      await sequelize.query(
        `UPDATE public.tenants
         SET cutover_last_status = 'failed', cutover_last_error = :error, cutover_last_attempt_at = NOW()
         WHERE id = :tenantId`,
        { replacements: { tenantId: tenant.id, error: String(err && err.message ? err.message : err).slice(0, 4000) } }
      ).catch(() => {});
      throw err;
    }
  } finally {
    if (locked) {
      await sequelize.query(
        `SELECT pg_advisory_unlock(hashtext(:key))`,
        { replacements: { key: `cutover:${slug}` } }
      ).catch(() => {}); // close() de todas formas suelta el lock de sesión
    }
    await sequelize.close();
  }
}

async function runCutoverSteps(sequelize, slug, tenant) {
  console.log(`\n=== 1/3 Aprovisionando schema para "${slug}" ===`);
  const { schemaName, cloned } = await provisionTenantSchemaDetailed(slug);

  console.log(`\n=== 2/3 Copiando y verificando datos ===`);
  await migrateTenantData(slug, tenant.id, { freshSchema: cloned });

  // La migración que siembra diagram_templates en el schema nuevo no pone
  // image_path (ver 2026072502-seed-diagram-templates-catalog.js); eso lo
  // completa seedDiagramTemplates(), que solo corre al arrancar el server.
  // Sin este paso, un tenant creado después del último reinicio veía los
  // diagramas en blanco hasta el siguiente deploy. No es fatal: si falla,
  // el próximo arranque lo vuelve a intentar.
  try {
    const { seedDiagramTemplatesInSchema } = require('../services/seedDiagramTemplates');
    await seedDiagramTemplatesInSchema(schemaName);
  } catch (err) {
    console.warn(`⚠️  No se pudo sincronizar diagram_templates en "${schemaName}": ${err.message}`);
  }

  console.log(`\n=== 3/3 Activando corte (schema_name) ===`);
  // Se registra el resultado acá mismo (no solo en el alta automática de
  // superadmin.routes.js): si no, un reintento manual exitoso con este
  // script dejaba el tenant migrado pero con el error del intento viejo
  // pintado en rojo en el panel de migración para siempre.
  await sequelize.query(
    `UPDATE public.tenants
     SET schema_name = :schemaName,
         cutover_last_status = 'success', cutover_last_error = NULL, cutover_last_attempt_at = NOW()
     WHERE id = :tenantId`,
    { replacements: { schemaName, tenantId: tenant.id } }
  );

  console.log(`\n✅ Tenant "${slug}" migrado y activo en "${schemaName}"`);
  // El servidor cachea el tenant ~30s (services/requestCache.js) y este
  // script no puede invalidar esa caché: hasta que venza, los requests
  // siguen usando el schema anterior.
  console.log('⚠️  Los servidores en marcha toman el cambio en ~30s (caché del tenant). Reinícialos si necesitas que sea inmediato.');
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