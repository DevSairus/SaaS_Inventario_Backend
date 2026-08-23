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
  // `wa_reminder_jobs` existe en `public` (columna tenant_id incluida) pero
  // no la crea ninguna migración de este repo -- no aparece en
  // src/database/migrations ni en el historial de git. Es una tabla ajena
  // al esquema versionado (creada a mano o por un servicio externo de
  // recordatorios de WhatsApp que comparte esta base de datos), así que
  // provisionTenantSchema.js nunca la crea en los schemas de tenant.
  // Sin esta exclusión, migrateTenantData.js/cleanupTenantPublicData.js/
  // tenantPurgeService.js la tratan como tabla de tenant y revientan con
  // "relation ... does not exist" al intentar copiarla/borrarla en el schema.
  'wa_reminder_jobs',
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
 * @returns {Promise<{directTables: string[], indirectTables: string[], resolutionChains: Map<string, Array<Array<{column:string, parentTable:string, parentColumn:string}>>>}>}
 *
 * resolutionChains[table] es la lista de TODAS las cadenas de saltos posibles
 * (cada cadena, 1 o más saltos) para llegar desde `table` hasta una tabla
 * directa. Casi siempre hay una sola. Ej: customer_return_items ->
 *   [ [{ column: 'sale_item_id', parentTable: 'sale_items', parentColumn: 'id' }] ]
 *
 * OJO -- por qué es una LISTA de cadenas y no una sola: algunas tablas son
 * polimórficas, con más de una FK nullable que puede llevar al tenant según
 * el tipo de fila (ej. commission_settlement_items tiene `sale_id` Y
 * `work_order_id`, cada fila usa una U OTRA, nunca ambas). Elegir una sola
 * cadena (la versión vieja de esta función tomaba la primera en orden
 * alfabético) deja huérfanas las filas que usan la columna no elegida --
 * bug real: en producción TODAS las filas de commission_settlement_items
 * usaban work_order_id (sale_id siempre NULL), pero se había elegido la
 * cadena por sale_id -> el conteo/borrado por tenant nunca las veía, y
 * cleanupTenantPublicData.js/tenantPurgeService.js reventaban después al
 * borrar work_orders por la FK que dejaban sin limpiar. Guardar todas las
 * cadenas y combinarlas con OR (ver buildIndirectExistsSql) cubre ambos
 * casos sin adivinar cuál usa cada fila.
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
  // A diferencia de la versión anterior, NO se detiene en el primer FK que
  // resuelve -- junta TODOS los que resuelven, para no perder filas de
  // tablas polimórficas (ver comentario de arriba).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, fks] of byChild.entries()) {
      if (resolved.has(child)) continue;
      const chains = [];
      for (const fk of fks) {
        if (!resolved.has(fk.parent_table)) continue;
        const hop = { column: fk.child_column, parentTable: fk.parent_table, parentColumn: fk.parent_column };
        // [[]] = el padre ya es una tabla directa (cadena vacía, este hop
        // alcanza sola). Si el padre a su vez es indirecto con varias
        // cadenas propias, cada una se combina con este hop.
        const parentChains = resolutionChains.get(fk.parent_table) || [[]];
        for (const parentChain of parentChains) {
          chains.push([hop, ...parentChain]);
        }
      }
      if (chains.length) {
        resolutionChains.set(child, chains);
        resolved.add(child);
        changed = true;
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

/**
 * EXISTS correlacionado para UNA cadena, anclado en `outerAlias` (la fila de
 * la tabla indirecta que se está evaluando). El primer salto se correlaciona
 * contra `outerAlias`; los siguientes (si la cadena tiene más de un hop)
 * encadenan entre sí, y el último exige `tenant_id = :tenantId`.
 */
function buildIndirectExistsSql(chain, schema, outerAlias) {
  const [firstHop, ...restHops] = chain;
  let sql = `EXISTS (SELECT 1 FROM "${schema}"."${firstHop.parentTable}" c0`;
  let prevAlias = 'c0';
  restHops.forEach((hop, i) => {
    const alias = `c${i + 1}`;
    sql += ` JOIN "${schema}"."${hop.parentTable}" ${alias} ON ${prevAlias}."${hop.column}" = ${alias}."${hop.parentColumn}"`;
    prevAlias = alias;
  });
  sql += ` WHERE ${outerAlias}."${firstHop.column}" = c0."${firstHop.parentColumn}" AND ${prevAlias}."tenant_id" = :tenantId)`;
  return sql;
}

/**
 * Combina TODAS las cadenas de un `resolutionChains.get(table)` con OR --
 * necesario para tablas polimórficas donde distintas filas resuelven el
 * tenant por columnas distintas (ver comentario en discoverTenantTables).
 */
function buildIndirectOrExistsSql(table, resolutionChains, schema, outerAlias) {
  const chains = resolutionChains.get(table);
  if (!chains || !chains.length) throw new Error(`No hay cadena de resolución para "${table}"`);
  return chains.map((chain) => buildIndirectExistsSql(chain, schema, outerAlias)).join('\n     OR ');
}

/** SELECT count(*) de una tabla indirecta filtrando por el tenant_id "prestado". */
function buildIndirectCountSql(table, resolutionChains, schema) {
  return `SELECT count(*) FROM "${schema}"."${table}" t0 WHERE ${buildIndirectOrExistsSql(table, resolutionChains, schema, 't0')}`;
}

/** DELETE de una tabla indirecta en `schema`, filtrando por el tenant_id "prestado". */
function buildIndirectDeleteSql(table, resolutionChains, schema) {
  return `DELETE FROM "${schema}"."${table}" t0 WHERE ${buildIndirectOrExistsSql(table, resolutionChains, schema, 't0')}`;
}

/**
 * SELECT de filas de una tabla indirecta para copiarlas a un schema de tenant.
 * `selectExprs` ya deben venir calificados con el prefijo `t0.` para las
 * columnas simples (las transformadas/casteadas se pasan tal cual).
 */
function buildIndirectSourceSql(table, resolutionChains, selectExprs) {
  return `SELECT ${selectExprs} FROM "public"."${table}" t0 WHERE ${buildIndirectOrExistsSql(table, resolutionChains, 'public', 't0')}`;
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
