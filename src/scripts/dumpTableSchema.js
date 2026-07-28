// src/scripts/dumpTableSchema.js
//
// Genera CREATE TABLE / constraints / índices reales para un set de tablas,
// leyendo directo de pg_catalog (no depende de tener pg_dump instalado).
//
// Uso:
//   node src/scripts/dumpTableSchema.js > baseline_sales_real.sql
//
// Conecta con DATABASE_URL_DIRECT / POSTGRES_URL / DATABASE_URL (igual que
// tus otros scripts), y asume que las tablas viven en el schema "public"
// (la BD compartida vieja, antes del cutover a schema-per-tenant).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Tablas de control-plane / billing que SÍ viven en "public" a propósito
// (compartidas entre tenants) — no son fantasma, no van en el baseline
// del tenant, así que se excluyen del escaneo aunque no tengan createTable.
const SHARED_PUBLIC_TABLES = new Set([
  'tenants',
  'users',
  'permissions',
  'role_permissions',
  'subscription_plans',
  'subscription_invoices',
  'tenant_subscriptions',
  'superadmin_mercadopago_config',
  'tenant_mercadopago_config',
  'sequelize_migrations',
  'SequelizeMeta',
  'announcements',
  'user_announcement_views',
]);

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

function findTablesCreatedByMigrations() {
  const created = new Set();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const m of content.matchAll(/createTable\(\s*[`'"]([a-zA-Z_]+)[`'"]/g)) {
      created.add(m[1]);
    }
    for (const m of content.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "?([a-zA-Z_]+)"?/g)) {
      created.add(m[1]);
    }
  }
  return created;
}

async function findPhantomTables(client) {
  const created = findTablesCreatedByMigrations();
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const phantom = rows
    .map((r) => r.table_name)
    .filter((t) => !created.has(t) && !SHARED_PUBLIC_TABLES.has(t));
  return phantom.sort();
}

const DATABASE_URL =
  process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

async function getColumns(client, table) {
  const { rows } = await client.query(
    `
    SELECT a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS column_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
    `,
    [`public.${table}`]
  );
  return rows;
}

async function getConstraints(client, table) {
  const { rows } = await client.query(
    `
    SELECT conname, contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = $1::regclass
    ORDER BY CASE contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname
    `,
    [`public.${table}`]
  );
  return rows;
}

async function getExtraIndexes(client, table) {
  const { rows } = await client.query(
    `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = $1
      AND indexname NOT IN (
        SELECT conname FROM pg_constraint
        WHERE conrelid = $2::regclass AND contype IN ('p', 'u')
      )
    ORDER BY indexname
    `,
    [table, `public.${table}`]
  );
  return rows;
}

async function tableExists(client, table) {
  const { rows } = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${table}`]
  );
  return rows[0].exists;
}

async function main() {
  if (!DATABASE_URL) {
    console.error('❌ No encontré DATABASE_URL_DIRECT / POSTGRES_URL / DATABASE_URL en el .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
  });
  await client.connect();

  const TABLES = await findPhantomTables(client);
  console.error(`ℹ️  Tablas fantasma detectadas (${TABLES.length}): ${TABLES.join(', ')}\n`);

  const createStatements = [];
  const constraintStatements = [];
  const indexStatements = [];
  const missing = [];

  for (const table of TABLES) {
    const exists = await tableExists(client, table);
    if (!exists) {
      missing.push(table);
      continue;
    }

    const columns = await getColumns(client, table);
    const colLines = columns.map((c) => {
      let line = `    "${c.column_name}" ${c.data_type}`;
      if (c.not_null) line += ' NOT NULL';
      if (c.column_default) line += ` DEFAULT ${c.column_default}`;
      return line;
    });
    createStatements.push(
      `CREATE TABLE IF NOT EXISTS ${table} (\n${colLines.join(',\n')}\n);`
    );

    const constraints = await getConstraints(client, table);
    for (const c of constraints) {
      constraintStatements.push(
        `ALTER TABLE ${table} ADD CONSTRAINT "${c.conname}" ${c.def};`
      );
    }

    const indexes = await getExtraIndexes(client, table);
    for (const idx of indexes) {
      indexStatements.push(`${idx.indexdef};`);
    }
  }

  await client.end();

  console.log('-- ============================================================');
  console.log('-- DDL generado automáticamente desde pg_catalog (public schema)');
  console.log(`-- Tablas: ${TABLES.join(', ')}`);
  console.log('-- ============================================================\n');

  if (missing.length) {
    console.log(
      `-- ⚠️  No existían en public y se omitieron: ${missing.join(', ')}\n`
    );
  }

  console.log('-- ── TABLAS ──────────────────────────────────────────────────\n');
  console.log(createStatements.join('\n\n'));

  console.log('\n\n-- ── CONSTRAINTS (PK, FK, UNIQUE, CHECK) ────────────────────\n');
  console.log(constraintStatements.join('\n'));

  console.log('\n\n-- ── ÍNDICES ─────────────────────────────────────────────────\n');
  console.log(indexStatements.join('\n'));
}

main().catch((err) => {
  console.error('❌ Error generando el DDL:', err);
  process.exit(1);
});