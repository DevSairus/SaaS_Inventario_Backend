// src/scripts/migrateTenantData.js
//
// Uso: node src/scripts/migrateTenantData.js <tenant_slug>
//
// Requiere que provisionTenantSchema.js ya se haya corrido para ese tenant
// (el schema y las tablas deben existir y estar vacías).
//
// Copia cada fila de las tablas "por tenant" en public que tenga
// tenant_id = <id del tenant>, hacia la tabla homónima en su schema nuevo.
//
// IMPORTANTE: SÍ se copia la columna tenant_id tal cual (no se excluye).
// Las tablas nuevas se crearon con las mismas migraciones, así que esa
// columna sigue existiendo (y normalmente es NOT NULL) -> omitirla rompe
// el INSERT. El aislamiento real ahora lo da el schema; tenant_id queda
// como columna redundante que se elimina en un paso de limpieza aparte,
// cuando ya no haya ninguna duda de que la migración fue exitosa.
//
// El orden de copiado respeta las foreign keys (padres antes que hijos)
// vía un topological sort sobre information_schema.

require('dotenv').config();
const { Sequelize } = require('sequelize');
const { schemaNameFor } = require('./provisionTenantSchema');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

// Tablas que NUNCA se copian a schema de tenant (se quedan en public)
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
    SELECT
      tc.table_name AS child,
      ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);

  const deps = new Map(tables.map(t => [t, new Set()]));
  for (const { child, parent } of fkRows) {
    if (tableSet.has(child) && tableSet.has(parent) && child !== parent) {
      deps.get(child).add(parent);
    }
  }

  const sorted = [];
  const visited = new Set();
  function visit(t, stack = new Set()) {
    if (visited.has(t)) return;
    if (stack.has(t)) return; // ciclo -> lo dejamos, se resuelve con FKs diferibles
    stack.add(t);
    for (const dep of deps.get(t) || []) visit(dep, stack);
    stack.delete(t);
    visited.add(t);
    sorted.push(t);
  }
  for (const t of tables) visit(t);
  return sorted;
}

async function migrateTenantData(slug, tenantId) {
  const schemaName = schemaNameFor(slug);
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: false,
  });

  try {
    const tables = await getTenantTables(sequelize);
    const ordered = await topoSort(sequelize, tables);
    console.log(`Orden de copiado (${ordered.length} tablas):`, ordered.join(', '));

    const report = [];

    for (const table of ordered) {
      const [cols] = await sequelize.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
        ORDER BY ordinal_position
      `);
      const colNames = cols.map(c => `"${c.column_name}"`).join(', ');

      const [[{ count: sourceCount }]] = await sequelize.query(
        `SELECT count(*) FROM "public"."${table}" WHERE tenant_id = :tenantId`,
        { replacements: { tenantId } }
      );

      if (Number(sourceCount) === 0) {
        report.push({ table, source: 0, copied: 0, ok: true });
        continue;
      }

      await sequelize.query(
        `INSERT INTO "${schemaName}"."${table}" (${colNames})
         SELECT ${colNames} FROM "public"."${table}" WHERE tenant_id = :tenantId`,
        { replacements: { tenantId } }
      );

      const [[{ count: destCount }]] = await sequelize.query(
        `SELECT count(*) FROM "${schemaName}"."${table}"`
      );

      report.push({
        table,
        source: Number(sourceCount),
        copied: Number(destCount),
        ok: Number(sourceCount) === Number(destCount),
      });
    }

    console.table(report);
    const failed = report.filter(r => !r.ok);
    if (failed.length) {
      throw new Error(`Verificación falló en: ${failed.map(f => f.table).join(', ')}`);
    }
    console.log(`✅ Datos de "${slug}" copiados y verificados en "${schemaName}"`);
    return report;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  const slug = process.argv[2];
  const tenantId = process.argv[3];
  if (!slug || !tenantId) {
    console.error('Uso: node migrateTenantData.js <tenant_slug> <tenant_id_uuid>');
    process.exit(1);
  }
  migrateTenantData(slug, tenantId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error migrando datos:', err);
      process.exit(1);
    });
}

module.exports = { migrateTenantData };