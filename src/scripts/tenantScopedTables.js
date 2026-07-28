// src/scripts/tenantScopedTables.js
//
// Descubrimiento centralizado de "tablas de tenant" para migrateTenantData.js,
// cleanupTenantPublicData.js y tenantPurgeService.js.
//
// Problema que resuelve: los tres scripts encontraban sus tablas filtrando
// information_schema.columns por `column_name = 'tenant_id'`. Eso es correcto
// para la mayoría de las tablas, pero deja afuera a las que se relacionan con
// el tenant SOLO de forma indirecta -- ej. `customer_return_items`, que no
// tiene tenant_id propio y cuelga de `sale_items` vía `sale_item_id`.
//
// Consecuencia real que causó el bug: migrateTenantData.js nunca copió esas
// filas al schema del tenant (no las veía), y cleanupTenantPublicData.js /
// tenantPurgeService.js tampoco las contaban para borrar -- así que al
// intentar borrar `sale_items` de `public`, revienta con
// "violates foreign key constraint ... on table customer_return_items".
//
// Este módulo calcula, además de las tablas directas, el cierre transitivo:
// cualquier tabla que llegue (vía FK, directa o en cadena) hasta una tabla
// con tenant_id propio queda marcada como "indirecta", con la cadena exacta
// de columnas que hay que atravesar para resolver de qué tenant es cada fila.

const PUBLIC_ONLY_TABLES = new Set([
  'tenants', 'users', 'subscription_plans', 'tenant_subscriptions',
  'subscription_invoices', 'super_admin_mercadopago_config',
  'permissions', 'role_permissions', 'announcements',
  'user_announcement_views', 'sequelize_migrations', 'SequelizeMeta',
]);

async function getAllFkEdges(sequelize) {
  // Grafo COMPLETO de FKs en public (no solo entre un set dado): hace falta
  // para poder caminar hacia arriba desde cualquier tabla hija.
  const [rows] = await sequelize.query(`
    SELECT
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  return rows;
}

async function getDirectTenantTables(sequelize) {
  const [rows] = await sequelize.query(`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
  `);
  return rows.map((r) => r.table_name).filter((t) => !PUBLIC_ONLY_TABLES.has(t));
}

/**
 * @returns {Promise<{directTables: string[], indirectTables: string[], resolutionChains: Map<string, Array<{column:string, parentTable:string, parentColumn:string}>>}>}
 *
 * resolutionChains[table] es la cadena de saltos (1 o más) para llegar desde
 * `table` hasta una tabla directa. Ej: customer_return_items ->
 *   [{ column: 'sale_item_id', parentTable: 'sale_items', parentColumn: 'id' }]
 */
async function discoverTenantTables(sequelize) {
  const directTables = await getDirectTenantTables(sequelize);
  const directSet = new Set(directTables);
  const edges = await getAllFkEdges(sequelize);

  const byChild = new Map();
  for (const e of edges) {
    if (PUBLIC_ONLY_TABLES.has(e.child_table) || PUBLIC_ONLY_TABLES.has(e.parent_table)) continue;
    if (e.child_table === e.parent_table) continue; // auto-referencias no aportan tenant scope
    if (!byChild.has(e.child_table)) byChild.set(e.child_table, []);
    byChild.get(e.child_table).push(e);
  }

  const resolutionChains = new Map();
  const resolved = new Set(directTables);

  // Punto fijo: cada vuelta puede resolver tablas que dependen de otras
  // recién resueltas en la vuelta anterior (cadenas de más de un salto).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, fks] of byChild.entries()) {
      if (resolved.has(child)) continue;
      // Orden determinista si hay más de un camino válido (ej.
      // customer_return_items tiene sale_item_id Y product_id, los dos
      // terminan en una tabla con tenant_id).
      const sortedFks = [...fks].sort((a, b) => a.child_column.localeCompare(b.child_column));
      for (const fk of sortedFks) {
        if (resolved.has(fk.parent_table)) {
          const parentChain = resolutionChains.get(fk.parent_table) || [];
          resolutionChains.set(child, [
            { column: fk.child_column, parentTable: fk.parent_table, parentColumn: fk.parent_column },
            ...parentChain,
          ]);
          resolved.add(child);
          changed = true;
          break;
        }
      }
    }
  }

  const indirectTables = [...resolved].filter((t) => !directSet.has(t));
  return { directTables, indirectTables, resolutionChains };
}

/** Orden topológico sobre un set de tablas dado (mismo grafo de FKs de public). */
async function tablesInOrder(sequelize, tables, { forDelete = false } = {}) {
  const tableSet = new Set(tables);
  const edges = await getAllFkEdges(sequelize);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child_table, parent_table } of edges) {
    if (tableSet.has(child_table) && tableSet.has(parent_table) && child_table !== parent_table) {
      deps.get(child_table).add(parent_table);
    }
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
  return forDelete ? sorted.reverse() : sorted;
}

/** SELECT count(*) de una tabla indirecta filtrando por el tenant_id "prestado". */
function buildIndirectCountSql(table, resolutionChains, schema) {
  const chain = resolutionChains.get(table);
  if (!chain) throw new Error(`No hay cadena de resolución para "${table}"`);
  let sql = `SELECT count(*) FROM "${schema}"."${table}" t0`;
  let prevAlias = 't0';
  chain.forEach((step, i) => {
    const alias = `t${i + 1}`;
    sql += ` JOIN "${schema}"."${step.parentTable}" ${alias} ON ${prevAlias}."${step.column}" = ${alias}."${step.parentColumn}"`;
    prevAlias = alias;
  });
  sql += ` WHERE ${prevAlias}."tenant_id" = :tenantId`;
  return sql;
}

/** DELETE de una tabla indirecta en `schema`, filtrando por el tenant_id "prestado". */
function buildIndirectDeleteSql(table, resolutionChains, schema) {
  const chain = resolutionChains.get(table);
  if (!chain) throw new Error(`No hay cadena de resolución para "${table}"`);
  const usingParts = [];
  const whereParts = [];
  let prevAlias = 't0';
  chain.forEach((step, i) => {
    const alias = `t${i + 1}`;
    usingParts.push(`"${schema}"."${step.parentTable}" ${alias}`);
    whereParts.push(`t0."${step.column}" = ${alias}."${step.parentColumn}"`);
    prevAlias = alias;
  });
  whereParts.push(`${prevAlias}."tenant_id" = :tenantId`);
  return `DELETE FROM "${schema}"."${table}" t0 USING ${usingParts.join(', ')} WHERE ${whereParts.join(' AND ')}`;
}

/**
 * SELECT de filas de una tabla indirecta para copiarlas a un schema de tenant.
 * `selectExprs` ya deben venir calificados con el prefijo `t0.` para las
 * columnas simples (las transformadas/casteadas se pasan tal cual).
 */
function buildIndirectSourceSql(table, resolutionChains, selectExprs) {
  const chain = resolutionChains.get(table);
  if (!chain) throw new Error(`No hay cadena de resolución para "${table}"`);
  let sql = `SELECT ${selectExprs} FROM "public"."${table}" t0`;
  let prevAlias = 't0';
  chain.forEach((step, i) => {
    const alias = `t${i + 1}`;
    sql += ` JOIN "public"."${step.parentTable}" ${alias} ON ${prevAlias}."${step.column}" = ${alias}."${step.parentColumn}"`;
    prevAlias = alias;
  });
  sql += ` WHERE ${prevAlias}."tenant_id" = :tenantId`;
  return sql;
}

module.exports = {
  PUBLIC_ONLY_TABLES,
  getAllFkEdges,
  getDirectTenantTables,
  discoverTenantTables,
  tablesInOrder,
  buildIndirectCountSql,
  buildIndirectDeleteSql,
  buildIndirectSourceSql,
};
