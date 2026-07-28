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

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { schemaNameFor } = require('./provisionTenantSchema');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

const PUBLIC_ONLY_TABLES = new Set([
  'tenants', 'users', 'subscription_plans', 'tenant_subscriptions',
  'subscription_invoices', 'super_admin_mercadopago_config',
  'permissions', 'role_permissions', 'announcements',
  'user_announcement_views', 'sequelize_migrations', 'SequelizeMeta',
]);

async function getTenantTables(sequelize) {
  const [rows] = await sequelize.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  `);
  return rows.map(r => r.table_name).filter(t => !PUBLIC_ONLY_TABLES.has(t));
}

async function topoSort(sequelize, tables) {
  const tableSet = new Set(tables);
  const [fkRows] = await sequelize.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  const deps = new Map(tables.map(t => [t, new Set()]));
  for (const { child, parent } of fkRows) {
    if (tableSet.has(child) && tableSet.has(parent) && child !== parent) deps.get(child).add(parent);
  }
  const sorted = [];
  const visited = new Set();
  function visit(t, stack = new Set()) {
    if (visited.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const dep of deps.get(t) || []) visit(dep, stack);
    stack.delete(t);
    visited.add(t);
    sorted.push(t);
  }
  for (const t of tables) visit(t);
  return sorted;
}

async function syncBackToPublic(sequelize, schemaName, tenantId) {
  const tables = await getTenantTables(sequelize);
  const ordered = await topoSort(sequelize, tables);
  const report = [];

  for (const table of ordered) {
    const [pkRows] = await sequelize.query(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = '"public"."${table}"'::regclass AND i.indisprimary
    `);
    const pk = pkRows[0]?.column_name || 'id';

    const [cols] = await sequelize.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}'
      ORDER BY ordinal_position
    `);
    const colNames = cols.map(c => `"${c.column_name}"`);
    const colList = colNames.join(', ');
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

    const [result] = await sequelize.query(
      `INSERT INTO "public"."${table}" (${colList})
       SELECT ${colList} FROM "${schemaName}"."${table}"
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