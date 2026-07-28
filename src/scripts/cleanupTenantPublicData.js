// backend/src/scripts/cleanupTenantPublicData.js
//
// Uso:
//   node src/scripts/cleanupTenantPublicData.js <tenant_slug>              (dry-run, solo reporta)
//   node src/scripts/cleanupTenantPublicData.js <tenant_slug> --execute    (borra de verdad)
//   node src/scripts/cleanupTenantPublicData.js --all [--execute]          (todos los tenants migrados)
//
// Contexto: cutoverTenant.js a propósito NO borra las filas viejas de
// `public` al migrar un tenant -- quedan como respaldo "por si algo salió
// mal" (ver comentario en ese archivo). Este script es el paso separado y
// consciente para borrarlas, una vez ya confirmaste en producción real que
// el tenant viene funcionando bien desde su schema dedicado.
//
// SEGURIDAD: por cada tabla, antes de borrar se compara:
//   count(public.<tabla> WHERE tenant_id = X)  vs  count(<schema>.<tabla> WHERE tenant_id = X)
// Si no coinciden, la tabla se SALTA (no se borra nada de ella) y se marca
// en el reporte -- puede significar que la migración quedó incompleta, o
// que algo después del cutover siguió escribiendo en public por error. En
// cualquiera de los dos casos hay que investigar a mano antes de borrar.
//
// Requiere tenants.schema_name seteado (si no, el tenant no está migrado
// y este script se niega a tocarlo).

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { schemaNameFor } = require('./provisionTenantSchema');
const {
  discoverTenantTables,
  tablesInOrder,
  buildIndirectCountSql,
  buildIndirectDeleteSql,
} = require('./tenantScopedTables');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function cleanupTenantPublicData(sequelize, { id: tenantId, slug, schema_name }, { execute = false } = {}) {
  const schemaName = schema_name || schemaNameFor(slug);
  console.log(`\n=== ${slug} (schema: ${schemaName}) ${execute ? '[EJECUTANDO]' : '[DRY-RUN]'} ===`);

  const { directTables, indirectTables, resolutionChains } = await discoverTenantTables(sequelize);
  if (indirectTables.length) {
    console.log(`ℹ️  Tablas indirectas detectadas (sin tenant_id propio, resueltas por FK): ${indirectTables.join(', ')}`);
  }
  const allTables = [...directTables, ...indirectTables];
  const ordered = await tablesInOrder(sequelize, allTables, { forDelete: true });
  const report = [];

  for (const table of ordered) {
    const isIndirect = resolutionChains.has(table) && !directTables.includes(table);

    const [[{ count: publicCount }]] = isIndirect
      ? await sequelize.query(buildIndirectCountSql(table, resolutionChains, 'public'), { replacements: { tenantId } })
      : await sequelize.query(
          `SELECT count(*) FROM "public"."${table}" WHERE tenant_id = :tenantId`,
          { replacements: { tenantId } }
        );

    // Para tablas indirectas, el schema del tenant ya está aislado por
    // definición (no tiene tenant_id propio ahí tampoco) -- basta contar
    // todas sus filas en ese schema, no hace falta re-resolver el join ahí.
    const [[{ count: schemaCount }]] = isIndirect
      ? await sequelize.query(`SELECT count(*) FROM "${schemaName}"."${table}"`)
      : await sequelize.query(
          `SELECT count(*) FROM "${schemaName}"."${table}" WHERE tenant_id = :tenantId`,
          { replacements: { tenantId } }
        );

    const pub = Number(publicCount);
    const sch = Number(schemaCount);

    if (pub === 0) {
      report.push({ table, public: 0, schema: sch, action: 'nada que borrar' });
      continue;
    }

    if (isIndirect && sch === 0) {
      // Nunca se migró (migrateTenantData.js tampoco la veía antes de este
      // fix) -- no borrar de public sin haberla copiado primero al schema.
      report.push({
        table, public: pub, schema: sch,
        action: '⚠️  SALTADA (schema tiene 0 filas -- nunca se migró, correr migrateTenantData.js primero)',
      });
      continue;
    }

    if (pub !== sch) {
      report.push({
        table, public: pub, schema: sch,
        action: '⚠️  SALTADA (conteos no coinciden, revisar a mano)',
      });
      continue;
    }

    if (execute) {
      if (isIndirect) {
        await sequelize.query(buildIndirectDeleteSql(table, resolutionChains, 'public'), { replacements: { tenantId } });
      } else {
        await sequelize.query(
          `DELETE FROM "public"."${table}" WHERE tenant_id = :tenantId`,
          { replacements: { tenantId } }
        );
      }
      report.push({ table, public: pub, schema: sch, action: `✅ borradas ${pub} filas` });
    } else {
      report.push({ table, public: pub, schema: sch, action: `borraría ${pub} filas` });
    }
  }

  console.table(report);
  const skipped = report.filter(r => r.action.includes('SALTADA'));
  if (skipped.length) {
    console.log(`⚠️  ${skipped.length} tabla(s) saltada(s) por conteos que no coinciden: ${skipped.map(s => s.table).join(', ')}`);
  }
  return report;
}

async function run(slugOrAll, { execute = false } = {}) {
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
  });

  try {
    let tenants;
    if (slugOrAll === '--all') {
      const [rows] = await sequelize.query(
        `SELECT id, slug, schema_name FROM public.tenants WHERE schema_name IS NOT NULL ORDER BY slug`
      );
      tenants = rows;
      if (!tenants.length) {
        console.log('No hay tenants con schema_name seteado (ninguno migrado todavía).');
        return;
      }
    } else {
      const [[tenant]] = await sequelize.query(
        `SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug`,
        { replacements: { slug: slugOrAll } }
      );
      if (!tenant) throw new Error(`Tenant "${slugOrAll}" no existe`);
      if (!tenant.schema_name) {
        throw new Error(`Tenant "${slugOrAll}" todavía NO está migrado (schema_name es NULL) -- nada que depurar en public todavía.`);
      }
      tenants = [tenant];
    }

    if (!execute) {
      console.log('ℹ️  Modo DRY-RUN (no se borra nada). Corre de nuevo con --execute para aplicar.');
    }

    for (const tenant of tenants) {
      await cleanupTenantPublicData(sequelize, tenant, { execute });
    }
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const target = args.find(a => a !== '--execute');

  if (!target) {
    console.error('Uso: node cleanupTenantPublicData.js <tenant_slug> [--execute]');
    console.error('     node cleanupTenantPublicData.js --all [--execute]');
    process.exit(1);
  }

  run(target, { execute })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error:', err.message);
      process.exit(1);
    });
}

module.exports = { cleanupTenantPublicData, run };