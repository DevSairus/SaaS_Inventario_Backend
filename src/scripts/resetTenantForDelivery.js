// src/scripts/resetTenantForDelivery.js
//
// Reset de un schema de tenant al momento de la entrega: el cliente usó el
// trial para probar (ventas, OTs, cotizaciones, contabilidad, tesorería,
// cartera, etc.) y hay que dejar esos módulos en cero SIN que tenga que
// volver a configurar todo (sedes, bodegas, categorías, plan de cuentas,
// plantillas, listas de precio, etc.).
//
// Uso: SOLO desde el panel de superadmin (ver routes/superadmin.routes.js,
// endpoint POST /tenants/:slug/reset-for-delivery) -- esto NO es un script
// de consola de uso libre como cleanupTenantPublicData.js, precisamente
// porque las decisiones de "catálogo dudoso" (productos/clientes/
// proveedores/vehículos) las tiene que tomar un humano autorizado por
// tenant, no algo que se corra a ciegas.
//
// Clasificación de tablas (qué se conserva, qué se borra, qué se pregunta)
// vive en tenantResetClassification.js -- ver ese archivo antes de tocar
// este. "Modo estricto": si el schema tiene una tabla que no está en NINGUNA
// de las tres listas de ese archivo, este script se niega a correr. Así, si
// mañana agregas un módulo/tabla nueva y te olvidás de clasificarla, el
// reset FALLA con un mensaje claro en vez de borrar (o dejar sin borrar) esa
// tabla por accidente -- la función en sí no necesita tocarse nunca, solo la
// lista de clasificación.

const { ALWAYS_KEEP, ALWAYS_WIPE, ASK_GROUPS, allClassifiedTables } = require('./tenantResetClassification');

async function getPhysicalTables(sequelize, schemaName) {
  const [rows] = await sequelize.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = :schemaName AND table_type = 'BASE TABLE'`,
    { replacements: { schemaName } }
  );
  return rows.map((r) => r.table_name);
}

// FKs DENTRO de un solo schema (a diferencia de tenantScopedTables.js, que
// resuelve el grafo de `public` para el modelo legado multi-tenant-por-fila).
async function getFkEdges(sequelize, schemaName) {
  const [rows] = await sequelize.query(
    `SELECT
       tc.table_name AS child_table,
       kcu.column_name AS child_column,
       ccu.table_name AS parent_table,
       ccu.column_name AS parent_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = :schemaName
       AND ccu.table_schema = :schemaName`,
    { replacements: { schemaName } }
  );
  return rows;
}

async function isColumnNullable(sequelize, schemaName, table, column) {
  const [[row]] = await sequelize.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = :schemaName AND table_name = :table AND column_name = :column`,
    { replacements: { schemaName, table, column } }
  );
  return row ? row.is_nullable === 'YES' : false;
}

// Orden hijos-primero para poder hacer DELETE sin violar FKs (solo mira
// relaciones ENTRE tablas del propio set -- las que apuntan afuera del set
// se resuelven aparte, ver resolveConflicts).
function topoOrderForDelete(tables, edges) {
  const tableSet = new Set(tables);
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
  return sorted.reverse(); // padres-primero -> hijos-primero
}

// Detecta filas de tablas CONSERVADAS que apuntan a tablas que se van a
// BORRAR. Si la columna es NULLABLE, se resuelve solo (se pone en NULL antes
// de borrar el padre). Si NO es nullable, es un conflicto real que no se
// puede resolver a ciegas -- se reporta y el reset se detiene.
async function resolveConflicts(sequelize, schemaName, keepSet, wipeSet, edges) {
  const nullOutOps = [];
  const blockingConflicts = [];

  for (const edge of edges) {
    const { child_table, child_column, parent_table } = edge;
    if (child_table === parent_table) continue;
    if (!keepSet.has(child_table) || !wipeSet.has(parent_table)) continue;

    const nullable = await isColumnNullable(sequelize, schemaName, child_table, child_column);
    if (nullable) {
      nullOutOps.push({ table: child_table, column: child_column, referencedTable: parent_table });
    } else {
      blockingConflicts.push({ table: child_table, column: child_column, referencedTable: parent_table });
    }
  }

  return { nullOutOps, blockingConflicts };
}

/**
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{id: string, slug: string, schema_name: string}} tenant
 * @param {{catalogo_productos: boolean, clientes: boolean, proveedores: boolean, vehiculos: boolean}} decisions
 *        true = conservar ese grupo dudoso, false = borrarlo también.
 * @param {{execute?: boolean, triggeredBy?: string|null}} opts - sin execute (default false), es dry-run: solo cuenta, no borra nada.
 */
async function resetTenantForDelivery(sequelize, tenant, decisions, { execute = false, triggeredBy = null } = {}) {
  const { schema_name: schemaName, slug } = tenant;
  if (!schemaName) {
    throw new Error(`Tenant "${slug}" no tiene schema dedicado (schema_name null) -- no aplica reset de entrega.`);
  }

  const missingDecisions = ASK_GROUPS.map((g) => g.key).filter((k) => typeof decisions?.[k] !== 'boolean');
  if (missingDecisions.length > 0) {
    throw new Error(`Faltan decisiones explícitas para: ${missingDecisions.join(', ')} (deben venir true/false, sin default).`);
  }

  // 1) Descubrir tablas físicas y validar que TODAS estén clasificadas
  //    ("modo estricto" -- ver comentario de cabecera).
  const physicalTables = await getPhysicalTables(sequelize, schemaName);
  const classified = allClassifiedTables();
  const unclassified = physicalTables.filter((t) => !classified.has(t));
  if (unclassified.length > 0) {
    throw new Error(
      `El schema "${schemaName}" tiene tabla(s) sin clasificar en tenantResetClassification.js: ` +
      `${unclassified.join(', ')}. Agrégalas a ALWAYS_KEEP, ALWAYS_WIPE o un ASK_GROUP antes de correr el reset.`
    );
  }
  const physicalSet = new Set(physicalTables);

  // 2) Armar el set final a conservar / borrar según las decisiones.
  const keepSet = new Set(ALWAYS_KEEP.filter((t) => physicalSet.has(t)));
  const wipeSet = new Set(ALWAYS_WIPE.filter((t) => physicalSet.has(t)));
  const groupDecisions = {};
  for (const group of ASK_GROUPS) {
    const keep = decisions[group.key] === true;
    groupDecisions[group.key] = keep;
    for (const t of group.tables) {
      if (!physicalSet.has(t)) continue;
      (keep ? keepSet : wipeSet).add(t);
    }
  }

  // 3) Resolver conflictos de FK entre lo conservado y lo borrado.
  const edges = await getFkEdges(sequelize, schemaName);
  const { nullOutOps, blockingConflicts } = await resolveConflicts(sequelize, schemaName, keepSet, wipeSet, edges);
  if (blockingConflicts.length > 0) {
    const detail = blockingConflicts
      .map((c) => `"${c.table}"."${c.column}" (NOT NULL) -> "${c.referencedTable}" (a borrar)`)
      .join('; ');
    throw new Error(
      `No se puede resolver automáticamente: ${detail}. Hay filas conservadas que dependen obligatoriamente ` +
      `de una tabla que se va a borrar. Ajusta las decisiones (conservar también "${blockingConflicts[0].referencedTable}") ` +
      `o revisa esos datos a mano antes de reintentar.`
    );
  }

  const deleteOrder = topoOrderForDelete([...wipeSet], edges);

  const report = {
    slug,
    schema: schemaName,
    execute,
    decisions: groupDecisions,
    kept_tables: [...keepSet].sort(),
    wipe: [],
    null_out: [],
    stock_reset: false,
  };

  // 4) Contar (siempre) y, si execute=true, ejecutar dentro de una transacción.
  const transaction = execute ? await sequelize.transaction() : null;
  try {
    for (const op of nullOutOps) {
      const [[{ count }]] = await sequelize.query(
        `SELECT count(*) FROM "${schemaName}"."${op.table}" WHERE "${op.column}" IS NOT NULL`,
        { transaction: transaction || undefined }
      );
      const rows = Number(count);
      if (execute && rows > 0) {
        await sequelize.query(
          `UPDATE "${schemaName}"."${op.table}" SET "${op.column}" = NULL WHERE "${op.column}" IS NOT NULL`,
          { transaction }
        );
      }
      report.null_out.push({ ...op, rows });
    }

    for (const table of deleteOrder) {
      const [[{ count }]] = await sequelize.query(
        `SELECT count(*) FROM "${schemaName}"."${table}"`,
        { transaction: transaction || undefined }
      );
      const rows = Number(count);
      if (execute && rows > 0) {
        await sequelize.query(`DELETE FROM "${schemaName}"."${table}"`, { transaction });
      }
      report.wipe.push({ table, rows });
    }

    const productsGroup = ASK_GROUPS.find((g) => g.key === 'catalogo_productos');
    if (productsGroup?.resetStockIfKept && groupDecisions.catalogo_productos && physicalSet.has('products')) {
      if (execute) {
        await sequelize.query(
          `UPDATE "${schemaName}"."products" SET current_stock = 0, reserved_stock = 0, available_stock = 0`,
          { transaction }
        );
      }
      report.stock_reset = true;
    }

    if (execute) await transaction.commit();
  } catch (error) {
    if (execute) await transaction.rollback();
    throw error;
  }

  if (execute) {
    try {
      const audit = require('../utils/audit');
      await audit({
        tenant_id: tenant.id,
        user_id: triggeredBy,
        action: 'tenant.reset_for_delivery',
        entity: 'Tenant',
        entity_id: tenant.id,
        changes: { slug, schema: schemaName, decisions: groupDecisions, wipe: report.wipe, null_out: report.null_out },
      });
    } catch (e) {
      console.error('[resetTenantForDelivery] No se pudo registrar el audit log:', e.message);
    }
  }

  return report;
}

module.exports = { resetTenantForDelivery };
