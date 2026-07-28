// src/scripts/rollbackTenant.js
//
// Uso: node src/scripts/rollbackTenant.js <tenant_slug> [--drop-schema]
//
// Revierte el corte de un tenant hacia modo legado (public + tenant_id):
//   1. Sincroniza hacia `public` cualquier fila nueva/editada que se haya
//      escrito en el schema del tenant DESPUÉS del cutover (upsert por id).
//   2. Pone tenants.schema_name = NULL -> el middleware vuelve a enrutar
//      ese tenant a modo legado en la siguiente request.
//   3. Por defecto NO borra el schema del tenant (queda como evidencia/
//      respaldo). Con --drop-schema sí lo elimina (usar solo cuando estés
//      100% seguro, ej. limpieza de pruebas en un tenant demo).
//
// LIMITACIÓN CONOCIDA: si se BORRARON filas dentro del schema del tenant
// después del cutover, esas bajas no se replican hacia public (el upsert
// no detecta deletes). Para pruebas con un tenant demo de corta duración
// esto normalmente no aplica; si migraste borrados reales, revisa
// manualmente o considera restaurar desde un branch de Neon en su lugar.
//
// El descubrimiento de tablas (directas por tenant_id propio + indirectas
// resueltas por FK transitiva, ej. customer_return_items -> sale_items) vive
// en tenantScopedTables.js, compartido con migrateTenantData.js y
// cleanupTenantPublicData.js -- antes este script tenía su propia lista
// (solo columna tenant_id) y se saltaba las indirectas sin avisar, dejándolas
// desincronizadas de public tras un rollback. Como el schema completo de un
// tenant le pertenece a él en exclusiva, las indirectas no necesitan filtro
// de tenant_id de ningún lado (ni en el schema origen ni en public destino)
// -- ver tenantScopedTables.js para el porqué.

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { schemaNameFor } = require('./provisionTenantSchema');
const { discoverTenantTables, tablesInOrder } = require('./tenantScopedTables');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function syncBackToPublic(sequelize, schemaName, tenantId) {
  const { directTables, indirectTables } = await discoverTenantTables(sequelize);
  if (indirectTables.length) {
    console.log(`ℹ️  Tablas indirectas detectadas (sin tenant_id propio, resueltas por FK): ${indirectTables.join(', ')}`);
  }
  // Orden de INSERT (padres antes que hijos) -- mismo grafo de FKs que usa
  // migrateTenantData.js para copiar en la dirección contraria.
  const ordered = await tablesInOrder(sequelize, [...directTables, ...indirectTables]);
  const report = [];

  for (const table of ordered) {
    const [pkRows] = await sequelize.query(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = '"public"."${table}"'::regclass AND i.indisprimary
    `);
    const pk = pkRows[0]?.column_name || 'id';

    // `public` es el destino final -- solo tiene sentido escribir columnas
    // que existan ahí. El schema del tenant puede tener columnas nuevas que
    // public todavía no tiene (ver comentario de intersección en
    // migrateTenantData.js); se ignoran acá, no hay dónde ponerlas.
    const [publicCols] = await sequelize.query(`
      SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `);
    const [schemaColRows] = await sequelize.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = '${schemaName}' AND table_name = '${table}'
    `);
    const schemaColSet = new Set(schemaColRows.map(r => r.column_name));
    const cols = publicCols.filter(c => schemaColSet.has(c.column_name));

    const colNames = cols.map(c => `"${c.column_name}"`);
    const colList = colNames.join(', ');
    // Los tipos ENUM son por-schema (mismo problema que migrateTenantData.js
    // al copiar en la dirección contraria): castear vía texto contra el tipo
    // del schema DESTINO (public) explícito.
    const selectExprs = cols.map(c => c.data_type === 'USER-DEFINED'
      ? `"${c.column_name}"::text::"public"."${c.udt_name}"`
      : `"${c.column_name}"`
    ).join(', ');
    const updateSet = colNames
      .filter(c => c !== `"${pk}"`)
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(', ');

    const [[{ count: schemaCount }]] = await sequelize.query(
      `SELECT count(*) FROM "${schemaName}"."${table}"`
    );

    if (Number(schemaCount) === 0) {
      report.push({ table, schemaRows: 0, synced: 0 });
      continue;
    }

    await sequelize.query(
      `INSERT INTO "public"."${table}" (${colList})
       SELECT ${selectExprs} FROM "${schemaName}"."${table}"
       ON CONFLICT ("${pk}") DO UPDATE SET ${updateSet}`
    );

    report.push({ table, schemaRows: Number(schemaCount), synced: 'ok' });
  }

  console.table(report);
  return report;
}

async function rollbackTenant(slug, { dropSchema = false } = {}) {
  const schemaName = schemaNameFor(slug);
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
  });

  try {
    const [[tenant]] = await sequelize.query(
      `SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug`,
      { replacements: { slug } }
    );
    if (!tenant) throw new Error(`Tenant "${slug}" no existe`);
    if (!tenant.schema_name) {
      console.log(`⚠️  Tenant "${slug}" ya está en modo legado (schema_name es NULL). Nada que hacer.`);
      return;
    }

    console.log(`\n=== 1/2 Sincronizando cambios de "${schemaName}" hacia public ===`);
    await syncBackToPublic(sequelize, schemaName, tenant.id);

    console.log(`\n=== 2/2 Desactivando corte (schema_name -> NULL) ===`);
    await sequelize.query(
      `UPDATE public.tenants SET schema_name = NULL WHERE id = :tenantId`,
      { replacements: { tenantId: tenant.id } }
    );

    if (dropSchema) {
      console.log(`\n🗑️  Eliminando schema "${schemaName}" (--drop-schema)`);
      await sequelize.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } else {
      console.log(`\nℹ️  Schema "${schemaName}" se conserva como respaldo (no se borró).`);
    }

    console.log(`\n✅ Tenant "${slug}" revertido a modo legado (public)`);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  const slug = process.argv[2];
  const dropSchema = process.argv.includes('--drop-schema');
  if (!slug) {
    console.error('Uso: node rollbackTenant.js <tenant_slug> [--drop-schema]');
    process.exit(1);
  }
  rollbackTenant(slug, { dropSchema })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error en rollback:', err);
      process.exit(1);
    });
}

module.exports = { rollbackTenant };