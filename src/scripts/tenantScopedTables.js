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
  'user_announcement_views', 'blog_posts', 'sequelize_migrations', 'SequelizeMeta',
  // Tiene tenant_id pero es de plataforma (qué empresas ve cada super_admin/
  // support) y solo existe en public -- sin esto el corte intentaba copiarla a
  // "tenant_<slug>.platform_user_tenants" y la limpieza la borraba de public.
  'platform_user_tenants',
]);

// Tablas con datos de un tenant que la app lee y escribe SIEMPRE en public,
// aunque el tenant esté cortado a su schema (PUBLIC_SCHEMA_MODELS en
// config/registerTenantSchemaHooks.js: soporte, integración con Meta, NCF,
// sincronización de la ensambladora). Su copia "de verdad" es la de public:
// el corte no las copia, el rollback no las toca y la limpieza de public no
// las borra (antes, "Limpiar public" las borraba si el conteo coincidía con
// la copia vieja del schema). La purga de un tenant sí las borra.
const PUBLIC_PINNED_TABLES = new Set([
  'support_tickets', 'support_ticket_messages', 'support_ticket_attachments',
  'remote_support_sessions', 'ncf_config', 'meta_config', 'tenant_meta_configs',
  'ensambladora_sync_credentials', 'ensambladora_eventos_sync',
]);

// OJO: estas dos consultas leen pg_catalog directamente, NO information_schema.
// Las vistas de information_schema (table_constraints, key_column_usage,
// constraint_column_usage) recorren TODOS los schemas de la base antes de
// filtrar por 'public', y con cada schema de tenant que se agrega se vuelven
// más lentas: en local, con 8 schemas, una sola corrida tardó 571 s, y se
// ejecutan 2 veces por cutover (y en cleanup/rollback/purge).

async function getAllFkEdges(sequelize, schemas = ['public']) {
  // Grafo COMPLETO de FKs en public (no solo entre un set dado): hace falta
  // para poder caminar hacia arriba desde cualquier tabla hija. Una fila por
  // par de columnas (las FKs compuestas se emparejan por posición).
  const [rows] = await sequelize.query(`
    SELECT DISTINCT
      child.relname AS child_table,
      ca.attname AS child_column,
      parent.relname AS parent_table,
      pa.attname AS parent_column
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(child_attnum, parent_attnum)
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.child_attnum
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = k.parent_attnum
    WHERE con.contype = 'f' AND cn.nspname IN (:schemas) AND pn.nspname = cn.nspname
  `, { replacements: { schemas } });
  return rows;
}

async function getDirectTenantTables(sequelize) {
  const [rows] = await sequelize.query(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
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
async function discoverTenantTables(sequelize, { schemas = ['public'], excludePublicPinned = false } = {}) {
  const result = await discoverAllTenantTables(sequelize, schemas);
  if (!excludePublicPinned) return result;
  const keep = (t) => !PUBLIC_PINNED_TABLES.has(t);
  // Una indirecta cuya única cadena pasa por una tabla fija de public
  // (support_ticket_messages -> support_tickets) también queda afuera.
  const indirectTables = result.indirectTables.filter((t) => keep(t)
    && (result.resolutionChains.get(t) || []).some((chain) => chain.every((hop) => keep(hop.parentTable))));
  return { ...result, directTables: result.directTables.filter(keep), indirectTables };
}

async function discoverAllTenantTables(sequelize, schemas) {
  const directTables = await getDirectTenantTables(sequelize);
  const directSet = new Set(directTables);
  // `schemas` suma FKs de otros schemas (el destino de un cutover): al
  // `public` de producción le faltan FKs y, sin ellas, una tabla indirecta
  // (ej. commission_settlement_items -> work_orders) no se descubría y ni se
  // limpiaba ni se copiaba. Las cadenas se evalúan contra public, así que
  // solo sirven las aristas cuyas tablas y columna hija existen en public.
  let edges = await getAllFkEdges(sequelize, schemas);
  if (schemas.some((s) => s !== 'public')) {
    const [cols] = await sequelize.query(`
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    `);
    const publicCols = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
    const seen = new Set();
    edges = edges.filter((e) => {
      const key = `${e.child_table}.${e.child_column}>${e.parent_table}.${e.parent_column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return publicCols.has(`${e.child_table}.${e.child_column}`) && publicCols.has(`${e.parent_table}.${e.parent_column}`);
    });
  }

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

/**
 * FKs que forman ciclos entre tablas distintas del set (componentes
 * fuertemente conexos, Tarjan). Ninguna orden de inserción de una sola
 * pasada respeta un ciclo: esas columnas hay que insertarlas en NULL y
 * rellenarlas al final. Devuelve [{ child_table, child_column, parent_table }].
 */
async function cyclicFkEdges(sequelize, tables, { schemas = ['public'] } = {}) {
  const tableSet = new Set(tables);
  const edges = (await getAllFkEdges(sequelize, schemas))
    .filter((e) => tableSet.has(e.child_table) && tableSet.has(e.parent_table) && e.child_table !== e.parent_table);
  const adj = new Map(tables.map((t) => [t, new Set()]));
  for (const e of edges) adj.get(e.child_table).add(e.parent_table);

  let index = 0;
  const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = [];
  const comp = new Map();
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v)) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.set(w, v); } while (w !== v);
    }
  };
  for (const t of tables) if (!idx.has(t)) strong(t);

  const seen = new Set();
  return edges.filter((e) => {
    if (comp.get(e.child_table) !== comp.get(e.parent_table)) return false;
    const key = `${e.child_table}.${e.child_column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Orden topológico sobre un set de tablas dado. Por defecto con el grafo de
 * FKs de public; `schemas` suma el de otros schemas (ej. el schema destino de
 * un cutover). Hace falta porque el `public` de producción es la base vieja y
 * le faltan FKs que el schema nuevo sí tiene (sales.warehouse_id -> warehouses):
 * con solo el grafo de public, el corte de lemans-motos borró bodegas antes
 * que las ventas que las usan (2026-11-15).
 */
async function tablesInOrder(sequelize, tables, { forDelete = false, schemas = ['public'], skipColumns = null } = {}) {
  const tableSet = new Set(tables);
  const edges = await getAllFkEdges(sequelize, schemas);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child_table, child_column, parent_table } of edges) {
    // skipColumns: FKs que se insertan en NULL y se rellenan después (ciclos)
    if (skipColumns && skipColumns.has(`${child_table}.${child_column}`)) continue;
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
  // Entre paréntesis: sin ellos, "A OR B AND x" se lee "A OR (B AND x)" al
  // combinar la condición con otra (le pasó al rollback, 2026-11-15).
  return `(${chains.map((chain) => buildIndirectExistsSql(chain, schema, outerAlias)).join('\n     OR ')})`;
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
  PUBLIC_PINNED_TABLES,
  getAllFkEdges,
  getDirectTenantTables,
  discoverTenantTables,
  tablesInOrder,
  cyclicFkEdges,
  buildIndirectOrExistsSql,
  buildIndirectCountSql,
  buildIndirectDeleteSql,
  buildIndirectSourceSql,
};
