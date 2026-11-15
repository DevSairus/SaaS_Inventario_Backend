// src/scripts/rollbackTenant.js
//
// Uso: node src/scripts/rollbackTenant.js <tenant_slug> [--drop-schema]
//
// Revierte el corte de un tenant hacia modo legado (public + tenant_id):
// deja los datos del tenant en `public` IGUALES a los de su schema y pone
// tenants.schema_name = NULL. Todo en UNA transacción: si cualquier paso o
// la verificación final falla, no cambia nada y el tenant sigue en su schema.
//
//   1. Anota las filas del tenant que están en public pero ya no en el schema
//      ("sobrantes": borradas después del corte, o sembradas dos veces con
//      ids distintos, ej. crm_loss_reasons al crear el tenant).
//   2. Suelta las referencias de otras filas del tenant hacia las sobrantes
//      (se reescriben en el paso 3) y las borra, hijos antes que padres.
//   3. Copia todas las filas del schema a public (upsert por PK), padres
//      antes que hijos. Las FKs circulares (nullable) entran en NULL y se
//      rellenan al final, igual que en el corte (migrateTenantData.js).
//   4. Verifica que cada tabla tenga en public las mismas filas que en el
//      schema y recién ahí pone schema_name = NULL.
//
// Solo se copian filas del tenant (tenant_id = el suyo): el catálogo global
// del schema (diagram_templates con tenant_id NULL) no se lleva a public, y
// las marcas de diagnóstico que lo usan se reenlazan al catálogo de public
// por su clave natural (vehicle_type, system, configuration).
//
// Por defecto NO borra el schema (queda como respaldo); --drop-schema sí.
// Mientras corre, el tenant debe estar sin operar: lo que se escriba en el
// schema durante el rollback no alcanza a pasar a public.
//
// Historia: la versión anterior hacía un upsert por id tabla por tabla, sin
// transacción, con el orden de FKs de public solo. Fallaba con ciclos de FK
// (warehouses <-> projects), con filas sembradas dos veces (unique por clave
// natural) y dejaba public a medio sincronizar al fallar (2026-11-15).

require('dotenv').config();
const { directDbDialectOptions } = require('./_directDbSsl');
const { Sequelize } = require('sequelize');
const { schemaNameFor } = require('./provisionTenantSchema');
const {
  discoverTenantTables, tablesInOrder, cyclicFkEdges, getAllFkEdges, buildIndirectOrExistsSql,
} = require('./tenantScopedTables');

const DATABASE_URL = process.env.DATABASE_URL_DIRECT || process.env.POSTGRES_URL || process.env.DATABASE_URL;

const DIAGRAM_MARK_TABLES = new Set(['work_order_diagnosis_marks', 'sale_diagnosis_marks']);

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function columnsOf(sequelize, schema, table) {
  const [rows] = await sequelize.query(`
    SELECT a.attname AS column_name, a.attnotnull AS not_null, t.typtype, format_type(a.atttypid, a.atttypmod) AS type_name,
           t.typname AS base_type,
           tn.nspname AS type_schema, t.typname AS udt_name, a.attgenerated <> '' AS generated
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace tn ON tn.oid = t.typnamespace
    WHERE n.nspname = :schema AND c.relname = :table AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `, { replacements: { schema, table } });
  return rows;
}

async function primaryKeyOf(sequelize, table) {
  const [rows] = await sequelize.query(`
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = (quote_ident('public') || '.' || quote_ident(:table))::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)
  `, { replacements: { table } });
  return rows.map((r) => r.column_name);
}

async function syncBackToPublic(sequelize, schemaName, tenantId) {
  const schemas = ['public', schemaName];
  const { directTables, indirectTables, resolutionChains } = await discoverTenantTables(sequelize, { schemas, excludePublicPinned: true });
  const directSet = new Set(directTables);
  // Solo tablas que existen en los dos lados.
  const [existing] = await sequelize.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = :schemaName AND c.relkind IN ('r', 'p')
  `, { replacements: { schemaName } });
  const inSchema = new Set(existing.map((r) => r.relname));
  const tables = [...directTables, ...indirectTables].filter((t) => inSchema.has(t));
  const tableSet = new Set(tables);

  // Columnas comunes, PK y forma de leer cada tabla.
  const meta = new Map();
  for (const table of tables) {
    const pubCols = await columnsOf(sequelize, 'public', table);
    const schCols = new Set((await columnsOf(sequelize, schemaName, table)).map((c) => c.column_name));
    const cols = pubCols.filter((c) => schCols.has(c.column_name) && !c.generated);
    const pk = await primaryKeyOf(sequelize, table);
    if (!pk.length) throw new Error(`La tabla public.${table} no tiene llave primaria: no se puede sincronizar con seguridad`);
    meta.set(table, { cols, pk, nullable: new Map(pubCols.map((c) => [c.column_name, !c.not_null])), triggerManaged: new Set() });
  }

  // Columnas que reescriben los triggers de public en cada INSERT/UPDATE
  // (updated_at = ahora, available_stock = current - reserved): public las
  // deja a su manera y la verificación no las compara.
  const [triggerRows] = await sequelize.query(`
    SELECT c.relname AS table_name, p.proname
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  `);
  const TRIGGER_COLUMNS = { update_updated_at_column: 'updated_at', calculate_available_stock: 'available_stock' };
  for (const { table_name, proname } of triggerRows) {
    if (meta.has(table_name) && TRIGGER_COLUMNS[proname]) meta.get(table_name).triggerManaged.add(TRIGGER_COLUMNS[proname]);
  }

  // Filas del tenant en cada lado. Directas: por tenant_id (deja afuera el
  // catálogo global del schema). Indirectas: en el schema todo es del tenant;
  // en public se resuelven por sus cadenas de FK.
  const schemaWhere = (table, alias) => (directSet.has(table) ? `${alias}."tenant_id" = :tenantId` : 'TRUE');
  const publicWhere = (table, alias) => (directSet.has(table)
    ? `${alias}."tenant_id" = :tenantId`
    : buildIndirectOrExistsSql(table, resolutionChains, 'public', alias));
  const pkMatch = (table, a, b) => meta.get(table).pk.map((k) => `${a}.${qi(k)} = ${b}.${qi(k)}`).join(' AND ');
  const replacements = { tenantId };

  // ── 1. Filas sobrantes: del tenant en public, pero no en el schema (por
  // PK). Solo se quitan las que CHOCAN por una clave única con una fila del
  // schema (ej. crm_loss_reasons sembrados dos veces con ids distintos): si
  // no, el upsert del paso 3 no podría entrar. Las demás se conservan y se
  // reportan -- pueden ser filas borradas en el schema después del corte,
  // pero también filas que algún proceso escribió en public, y borrarlas a
  // ciegas sería perder datos. Se anota todo ANTES de tocar nada.
  const keptStale = new Map(); // table -> filas sobrantes que se conservan
  const colliding = [];        // { table, tmp, n, map } -> filas que se quitan
  for (const table of tables) {
    const { pk, cols } = meta.get(table);
    const [[{ n: staleCount }]] = await sequelize.query(`
      SELECT count(*)::int AS n FROM "public".${qi(table)} p
      WHERE ${publicWhere(table, 'p')}
        AND NOT EXISTS (SELECT 1 FROM ${qi(schemaName)}.${qi(table)} s WHERE ${pkMatch(table, 's', 'p')} AND ${schemaWhere(table, 's')})
    `, { replacements });
    if (!staleCount) continue;

    // Índices únicos (no PK, sin expresiones ni predicado) cuyas columnas
    // existen en los dos lados.
    const [uniques] = await sequelize.query(`
      SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
      FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = (quote_ident('public') || '.' || quote_ident(:table))::regclass
        AND i.indisunique AND NOT i.indisprimary AND i.indexprs IS NULL AND i.indpred IS NULL
      GROUP BY i.indexrelid
    `, { replacements: { table } });
    const common = new Set(cols.map((c) => c.column_name));
    const keys = uniques.map((u) => u.cols).filter((ks) => ks.every((k) => common.has(k)));

    let removed = 0;
    if (keys.length && pk.length === 1) {
      const tmp = `rb_collide_${colliding.length}`;
      const collide = keys.map((ks) => `(${ks.map((k) => `p.${qi(k)} = s.${qi(k)} AND p.${qi(k)} IS NOT NULL`).join(' AND ')})`).join(' OR ');
      // old_id = fila sobrante de public, new_id = la fila del schema que la reemplaza
      await sequelize.query(`
        CREATE TEMP TABLE ${tmp} ON COMMIT DROP AS
        SELECT DISTINCT ON (p.${qi(pk[0])}) p.${qi(pk[0])} AS old_id, s.${qi(pk[0])} AS new_id
        FROM "public".${qi(table)} p
        JOIN ${qi(schemaName)}.${qi(table)} s ON (${collide}) AND ${schemaWhere(table, 's')}
        WHERE ${publicWhere(table, 'p')}
          AND NOT EXISTS (SELECT 1 FROM ${qi(schemaName)}.${qi(table)} s2 WHERE s2.${qi(pk[0])} = p.${qi(pk[0])} AND ${schemaWhere(table, 's2')})
        ORDER BY p.${qi(pk[0])}, s.${qi(pk[0])}
      `, { replacements });
      const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM ${tmp}`);
      if (n) { colliding.push({ table, tmp, n, pkCol: pk[0] }); removed = n; }
    }
    if (staleCount - removed) keptStale.set(table, staleCount - removed);
  }
  if (colliding.length) {
    console.log('ℹ️  Filas de public que chocan con el schema por clave única (se reemplazan):', colliding.map((c) => `${c.table}=${c.n}`).join(', '));
  }
  if (keptStale.size) {
    console.log('ℹ️  Filas del tenant que están en public y no en el schema (se conservan):', [...keptStale].map(([t, n]) => `${t}=${n}`).join(', '));
  }

  // ── 2. Las referencias a una fila que se quita pasan a la fila del schema
  // que la reemplaza; luego se quita.
  const publicEdges = await getAllFkEdges(sequelize, ['public']);
  for (const c of colliding) {
    for (const e of publicEdges) {
      if (e.parent_table !== c.table || e.parent_column !== c.pkCol) continue;
      await sequelize.query(`
        UPDATE "public".${qi(e.child_table)} x SET ${qi(e.child_column)} = m.new_id
        FROM ${c.tmp} m WHERE x.${qi(e.child_column)} = m.old_id
      `);
    }
  }
  const staleTables = colliding.map((c) => ({ table: c.table, tmp: c.tmp, pkCols: qi(c.pkCol), selectCols: 'old_id' }));
  let pending = [...staleTables];
  while (pending.length) {
    const blocked = [];
    let lastErr = null;
    for (const s of pending) {
      try {
        await sequelize.query('SAVEPOINT rb_del');
        await sequelize.query(`
          DELETE FROM "public".${qi(s.table)} p
          WHERE (${meta.get(s.table).pk.map((k) => `p.${qi(k)}`).join(', ')}) IN (SELECT ${s.selectCols} FROM ${s.tmp})
        `);
        await sequelize.query('RELEASE SAVEPOINT rb_del');
      } catch (err) {
        await sequelize.query('ROLLBACK TO SAVEPOINT rb_del');
        if (err?.parent?.code !== '23503') throw err;
        blocked.push(s);
        lastErr = err;
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`No se pudieron borrar filas sobrantes de public (${blocked.map((b) => b.table).join(', ')}): ${lastErr.parent?.detail || lastErr.message}`);
    }
    pending = blocked;
  }

  // ── 3. Copiar schema -> public, padres antes que hijos.
  // FKs circulares nullable: no cuentan para el orden. Cada fila entra en su
  // turno; si su FK circular apunta a algo que todavía no está en public
  // (filas creadas después del corte), esa columna entra en NULL y se
  // rellena al final -- y el trigger de public le pone updated_at = ahora a
  // esas pocas filas. Si apunta a algo que ya está (lo normal: datos de antes
  // del corte), entra completa. No se puede "esperar" a la fila: sus hijos
  // (ej. journal_entry_lines -> projects) fallarían.
  // Filas sin cambios no se tocan (el upsert solo actualiza si algo difiere).
  const deferred = new Map(); // table -> [{ column, parentTable, parentColumn }]
  const skipColumns = new Set();
  for (const e of await cyclicFkEdges(sequelize, tables, { schemas })) {
    const m = meta.get(e.child_table);
    const key = `${e.child_table}.${e.child_column}`;
    if (!m.cols.some((c) => c.column_name === e.child_column)) { skipColumns.add(key); continue; }
    if (!m.nullable.get(e.child_column)) continue; // NOT NULL: se respeta en el orden
    skipColumns.add(key);
    if (!deferred.has(e.child_table)) deferred.set(e.child_table, []);
    if (!deferred.get(e.child_table).some((d) => d.column === e.child_column)) {
      deferred.get(e.child_table).push({ column: e.child_column, parentTable: e.parent_table, parentColumn: e.parent_column });
    }
  }
  const ordered = await tablesInOrder(sequelize, tables, { schemas, skipColumns });
  // Las FKs NOT NULL de un ciclo se quedaron en el orden: el padre tiene que
  // quedar antes que el hijo, si no el ciclo no tiene solución.
  const pos = new Map(ordered.map((t, i) => [t, i]));
  const bad = (await getAllFkEdges(sequelize, schemas)).filter((e) => tableSet.has(e.child_table) && tableSet.has(e.parent_table)
    && e.child_table !== e.parent_table && !skipColumns.has(`${e.child_table}.${e.child_column}`)
    && meta.get(e.child_table).cols.some((c) => c.column_name === e.child_column)
    && pos.get(e.parent_table) > pos.get(e.child_table));
  if (bad.length) {
    throw new Error(`Orden imposible por FKs: ${[...new Set(bad.map((e) => `${e.child_table}.${e.child_column} -> ${e.parent_table}`))].join(', ')}`);
  }

  const valueExpr = (table, c) => {
    if (DIAGRAM_MARK_TABLES.has(table) && c.column_name === 'diagram_template_id') {
      // Plantilla propia del tenant: mismo id. Del catálogo del schema: la
      // equivalente del catálogo global de public.
      return `COALESCE(
        (SELECT sdt.id FROM ${qi(schemaName)}."diagram_templates" sdt WHERE sdt.id = s."diagram_template_id" AND sdt.tenant_id = :tenantId),
        (SELECT pdt.id FROM ${qi(schemaName)}."diagram_templates" sdt
           JOIN "public"."diagram_templates" pdt ON pdt.tenant_id IS NULL AND pdt.vehicle_type = sdt.vehicle_type
            AND pdt.system = sdt.system AND pdt.configuration = sdt.configuration
           WHERE sdt.id = s."diagram_template_id" LIMIT 1))`;
    }
    if (c.typtype === 'e') return `s.${qi(c.column_name)}::text::${qi(c.type_schema)}.${qi(c.udt_name)}`;
    return `s.${qi(c.column_name)}`;
  };
  const targetExists = (d) => `EXISTS (SELECT 1 FROM "public".${qi(d.parentTable)} x WHERE x.${qi(d.parentColumn)} = s.${qi(d.column)})`;
  const cmp = (alias, c) => (c.base_type === 'json' ? `${alias}.${qi(c.column_name)}::jsonb` : `${alias}.${qi(c.column_name)}`);

  // Upsert de una tabla; las FKs circulares sin destino todavía entran en NULL.
  const upsert = async (table) => {
    const { cols, pk } = meta.get(table);
    const byCol = new Map((deferred.get(table) || []).map((d) => [d.column, d]));
    const select = cols.map((c) => {
      const d = byCol.get(c.column_name);
      if (d) return `CASE WHEN ${targetExists(d)} THEN s.${qi(c.column_name)} END`;
      return valueExpr(table, c);
    }).join(', ');
    const nonPk = cols.filter((c) => !pk.includes(c.column_name));
    const conflict = nonPk.length
      ? `UPDATE SET ${nonPk.map((c) => `${qi(c.column_name)} = EXCLUDED.${qi(c.column_name)}`).join(', ')}
         WHERE (${nonPk.map((c) => cmp('p', c)).join(', ')}) IS DISTINCT FROM (${nonPk.map((c) => cmp('EXCLUDED', c)).join(', ')})`
      : 'NOTHING';
    const [[{ n }]] = await sequelize.query(`
      WITH up AS (
        INSERT INTO "public".${qi(table)} AS p (${cols.map((c) => qi(c.column_name)).join(', ')})
        SELECT ${select} FROM ${qi(schemaName)}.${qi(table)} s WHERE ${schemaWhere(table, 's')}
        ON CONFLICT (${pk.map(qi).join(', ')}) DO ${conflict}
        RETURNING 1
      ) SELECT count(*)::int AS n FROM up
    `, { replacements });
    return n;
  };

  const report = [];
  for (const table of ordered) {
    const [[{ n }]] = await sequelize.query(
      `SELECT count(*)::int AS n FROM ${qi(schemaName)}.${qi(table)} s WHERE ${schemaWhere(table, 's')}`, { replacements },
    );
    if (!n) continue;
    const written = await upsert(table);
    report.push({ table, filas: n, escritas: written });
  }
  let cyclicRows = 0;
  for (const [table, defs] of deferred) {
    for (const d of defs) {
      const [[{ n }]] = await sequelize.query(`
        WITH up AS (
          UPDATE "public".${qi(table)} p SET ${qi(d.column)} = s.${qi(d.column)}
          FROM ${qi(schemaName)}.${qi(table)} s
          WHERE ${pkMatch(table, 'p', 's')} AND ${schemaWhere(table, 's')}
            AND p.${qi(d.column)} IS DISTINCT FROM s.${qi(d.column)}
          RETURNING 1
        ) SELECT count(*)::int AS n FROM up
      `, { replacements });
      cyclicRows += n;
    }
  }
  if (cyclicRows) console.log(`ℹ️  ${cyclicRows} fila(s) con referencias circulares entre filas nuevas se completaron al final`);

  // ── 4. Verificación: cada fila del schema está en public (por PK) con el
  // mismo contenido en las columnas comunes, y public no tiene más filas del
  // tenant que las del schema + las sobrantes que se conservaron.
  const mismatches = [];
  for (const table of tables) {
    const { cols, triggerManaged } = meta.get(table);
    // Se comparan todas las columnas comunes menos las que reescriben los
    // triggers de public y el id de plantilla de diagrama (se reenlaza).
    const named = cols.filter((c) => !triggerManaged.has(c.column_name)
      && !(DIAGRAM_MARK_TABLES.has(table) && c.column_name === 'diagram_template_id'));
    const differs = named.map((c) => {
      const col = qi(c.column_name);
      if (c.typtype === 'e') return `p.${col}::text IS DISTINCT FROM s.${col}::text`;
      if (c.base_type === 'json' || c.base_type === 'jsonb') return `p.${col}::jsonb IS DISTINCT FROM s.${col}::jsonb`;
      return `p.${col} IS DISTINCT FROM s.${col}::${c.type_name}`;
    });
    const [[r]] = await sequelize.query(`
      SELECT
        (SELECT count(*)::int FROM ${qi(schemaName)}.${qi(table)} s WHERE ${schemaWhere(table, 's')}) AS schema_rows,
        (SELECT count(*)::int FROM "public".${qi(table)} p WHERE ${publicWhere(table, 'p')}) AS public_rows,
        (SELECT count(*)::int FROM ${qi(schemaName)}.${qi(table)} s WHERE ${schemaWhere(table, 's')}
           AND NOT EXISTS (SELECT 1 FROM "public".${qi(table)} p WHERE ${pkMatch(table, 'p', 's')})) AS missing,
        (SELECT count(*)::int FROM ${qi(schemaName)}.${qi(table)} s JOIN "public".${qi(table)} p ON ${pkMatch(table, 'p', 's')}
           WHERE ${schemaWhere(table, 's')} AND (${differs.length ? differs.join(' OR ') : 'FALSE'})) AS different
    `, { replacements });
    const expectedPublic = r.schema_rows + (keptStale.get(table) || 0);
    if (r.public_rows !== expectedPublic || r.missing || r.different) {
      const columns = [];
      if (r.different) {
        for (let i = 0; i < named.length; i++) {
          const [[d]] = await sequelize.query(`
            SELECT count(*)::int AS n FROM ${qi(schemaName)}.${qi(table)} s JOIN "public".${qi(table)} p ON ${pkMatch(table, 'p', 's')}
            WHERE ${schemaWhere(table, 's')} AND (${differs[i]})
          `, { replacements });
          if (d.n) columns.push(`${named[i].column_name}(${d.n})`);
        }
      }
      mismatches.push({ table, ...r, kept: keptStale.get(table) || 0, columns: columns.join(' ') });
    }
  }
  console.table(report.filter((r) => r.filas));
  if (mismatches.length) {
    console.table(mismatches);
    throw new Error(`La verificación del rollback falló en: ${mismatches.map((m) => m.table).join(', ')}`);
  }
  console.log(`✅ Verificado: ${tables.length} tablas con las mismas filas y el mismo contenido en public y en "${schemaName}"`);
  return report;
}

async function rollbackTenant(slug, { dropSchema = false } = {}) {
  const schemaName = schemaNameFor(slug);
  // Una sola conexión: la transacción, el lock de sesión y las tablas
  // temporales tienen que ir por la misma conexión física.
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: directDbDialectOptions(DATABASE_URL),
    logging: false,
    pool: { max: 1, min: 1 },
  });

  let locked = false;
  try {
    const [[{ ok }]] = await sequelize.query(
      'SELECT pg_try_advisory_lock(hashtext(:key)) AS ok', { replacements: { key: `cutover:${slug}` } },
    );
    if (!ok) throw new Error(`Ya hay un corte o rollback en curso para "${slug}". Espera a que termine.`);
    locked = true;

    const [[tenant]] = await sequelize.query(
      'SELECT id, slug, schema_name FROM public.tenants WHERE slug = :slug', { replacements: { slug } },
    );
    if (!tenant) throw new Error(`Tenant "${slug}" no existe`);
    if (!tenant.schema_name) {
      console.log(`⚠️  Tenant "${slug}" ya está en modo legado (schema_name es NULL). Nada que hacer.`);
      return;
    }

    await sequelize.query('BEGIN');
    try {
      console.log(`\n=== 1/2 Sincronizando "${schemaName}" hacia public (una transacción) ===`);
      await syncBackToPublic(sequelize, schemaName, tenant.id);

      console.log('\n=== 2/2 Desactivando corte (schema_name -> NULL) ===');
      await sequelize.query('UPDATE public.tenants SET schema_name = NULL WHERE id = :tenantId', { replacements: { tenantId: tenant.id } });
      await sequelize.query('COMMIT');
    } catch (err) {
      await sequelize.query('ROLLBACK').catch(() => {});
      console.error('↩️  Rollback abortado: no se cambió nada en public y el tenant sigue en su schema.');
      throw err;
    }

    if (dropSchema) {
      console.log(`\n🗑️  Eliminando schema "${schemaName}" (--drop-schema)`);
      await sequelize.query(`DROP SCHEMA IF EXISTS ${qi(schemaName)} CASCADE`);
    } else {
      console.log(`\nℹ️  Schema "${schemaName}" se conserva como respaldo (no se borró).`);
    }

    console.log(`\n✅ Tenant "${slug}" revertido a modo legado (public)`);
    // El servidor cachea el tenant ~30s (services/requestCache.js) y este
    // script no puede invalidar esa caché: hasta que venza, los requests
    // siguen usando el schema anterior.
    console.log('⚠️  Los servidores en marcha toman el cambio en ~30s (caché del tenant). Reinícialos si necesitas que sea inmediato.');
  } finally {
    if (locked) {
      await sequelize.query('SELECT pg_advisory_unlock(hashtext(:key))', { replacements: { key: `cutover:${slug}` } }).catch(() => {});
    }
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

module.exports = { rollbackTenant, syncBackToPublic };
