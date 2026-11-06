// src/scripts/cloneTenantSchema.js
//
// Crea el schema de un tenant nuevo clonando la estructura de la plantilla
// (tenantTemplate.js) en vez de correr las ~260 migraciones una por una.
// Contra Neon eso tardaba varios minutos por tenant (cada migración son
// varias idas y vueltas); el clon es UN solo envío de SQL en UNA transacción.
//
// Qué copia: enums, tablas (columnas, defaults, NOT NULL, columnas
// generadas, CHECK, comentarios), PK/UNIQUE/EXCLUDE, índices y FKs -- todo
// con sus nombres originales, porque hay migraciones posteriores que los
// buscan por nombre (por eso no se usa CREATE TABLE ... LIKE ... INCLUDING
// INDEXES, que los renombra). Las referencias al schema plantilla se
// reescriben al schema nuevo; las de public (tenants, users) quedan igual.
//
// Datos: sequelize_migrations completa (el tenant nace "al día") y las filas
// globales de la plantilla (tenant_id NULL, ej. el catálogo de
// diagram_templates). La plantilla no tiene filas de ningún tenant.
//
// Si la plantilla tiene un tipo de objeto que esto no sabe copiar
// (secuencias, vistas, funciones, triggers...), o si la verificación final
// encuentra cualquier diferencia de estructura, lanza error y la transacción
// se revierte entera: provisionTenantSchema.js cae al camino de migraciones.

const UNSUPPORTED_CHECKS = [
  ['secuencias / columnas identity', `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = :nsp AND c.relkind = 'S'`],
  ['vistas, vistas materializadas, tablas particionadas o foráneas', `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = :nsp AND c.relkind IN ('v','m','p','f')`],
  ['tipos compuestos, dominios o rangos', `SELECT t.typname AS name FROM pg_type t LEFT JOIN pg_class c ON c.oid = t.typrelid WHERE t.typnamespace = :nsp AND (t.typtype IN ('d','r','m') OR (t.typtype = 'c' AND c.relkind = 'c'))`],
  ['funciones o procedimientos', `SELECT p.proname AS name FROM pg_proc p WHERE p.pronamespace = :nsp`],
  ['triggers', `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = :nsp AND NOT t.tgisinternal`],
  ['políticas RLS', `SELECT p.polname AS name FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = :nsp`],
  ['reglas', `SELECT r.rulename AS name FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relnamespace = :nsp AND c.relkind = 'r'`],
  ['constraint triggers', `SELECT con.conname AS name FROM pg_constraint con WHERE con.connamespace = :nsp AND con.contype = 't'`],
];

const qi = (ident) => `"${String(ident).replace(/"/g, '""')}"`;
const ql = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Todo el catálogo se lee con search_path = pg_catalog para que
// format_type()/pg_get_expr()/pg_get_*def() califiquen con schema todo lo
// que no sea built-in. Así el único texto a reescribir es "<plantilla>.".
function makeRewriter(sourceSchema, targetSchema) {
  const from = `${sourceSchema}.`;
  const quotedFrom = `${qi(sourceSchema)}.`;
  const to = `${qi(targetSchema)}.`;
  return (sql) => (sql == null ? sql : String(sql).split(quotedFrom).join(to).split(from).join(to));
}

async function readDefinition(sequelize, transaction, schema) {
  const run = async (sql, replacements = {}) => {
    const [rows] = await sequelize.query(sql, { transaction, replacements: { ...replacements } });
    return rows;
  };

  const [nspRow] = await run(`SELECT oid FROM pg_namespace WHERE nspname = :schema`, { schema });
  if (!nspRow) return null;
  const nsp = nspRow.oid;

  const enums = await run(`
    SELECT t.typname AS name, json_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typnamespace = :nsp
    GROUP BY t.typname ORDER BY t.typname
  `, { nsp });

  const tables = await run(`
    SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant_id
    FROM pg_class c WHERE c.relnamespace = :nsp AND c.relkind = 'r'
    ORDER BY c.relname
  `, { nsp });

  const columns = await run(`
    SELECT c.relname AS table_name, a.attnum, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr,
           CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN co.collname END AS collation,
           col_description(c.oid, a.attnum) AS comment
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
    WHERE c.relnamespace = :nsp AND c.relkind = 'r'
    ORDER BY c.relname, a.attnum
  `, { nsp });

  // contype 'n' (NOT NULL como constraint, Postgres 18+) ya va en la columna.
  const constraints = await run(`
    SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relnamespace = :nsp AND c.relkind = 'r' AND con.contype IN ('c','p','u','x','f')
    ORDER BY c.relname, con.conname
  `, { nsp });

  const indexes = await run(`
    SELECT ic.relname AS name, c.relname AS table_name, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relnamespace = :nsp AND c.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p','u','x')
      )
    ORDER BY ic.relname
  `, { nsp });

  const unsupported = [];
  for (const [label, sql] of UNSUPPORTED_CHECKS) {
    const rows = await run(sql, { nsp });
    if (rows.length) unsupported.push(`${label}: ${rows.slice(0, 5).map((r) => r.name).join(', ')}`);
  }
  for (const col of columns) {
    if (col.identity) unsupported.push(`columna identity: ${col.table_name}.${col.name}`);
  }

  return { enums, tables, columns, constraints, indexes, unsupported };
}

function buildCloneSql(def, sourceSchema, targetSchema) {
  const rw = makeRewriter(sourceSchema, targetSchema);
  const T = qi(targetSchema);
  const S = qi(sourceSchema);
  const out = [];

  out.push(`CREATE SCHEMA IF NOT EXISTS ${T}`);

  for (const e of def.enums) {
    out.push(`CREATE TYPE ${T}.${qi(e.name)} AS ENUM (${e.labels.map(ql).join(', ')})`);
  }

  const columnsByTable = new Map();
  for (const col of def.columns) {
    if (!columnsByTable.has(col.table_name)) columnsByTable.set(col.table_name, []);
    columnsByTable.get(col.table_name).push(col);
  }

  for (const table of def.tables) {
    const cols = columnsByTable.get(table.name) || [];
    const colSql = cols.map((c) => {
      let s = `${qi(c.name)} ${rw(c.type)}`;
      if (c.collation) s += ` COLLATE ${qi(c.collation)}`;
      if (c.generated === 's') s += ` GENERATED ALWAYS AS (${rw(c.default_expr)}) STORED`;
      else if (c.default_expr != null) s += ` DEFAULT ${rw(c.default_expr)}`;
      if (c.not_null) s += ' NOT NULL';
      return s;
    });
    out.push(`CREATE TABLE ${T}.${qi(table.name)} (\n  ${colSql.join(',\n  ')}\n)`);
    if (table.comment != null) out.push(`COMMENT ON TABLE ${T}.${qi(table.name)} IS ${ql(table.comment)}`);
    for (const c of cols) {
      if (c.comment != null) out.push(`COMMENT ON COLUMN ${T}.${qi(table.name)}.${qi(c.name)} IS ${ql(c.comment)}`);
    }
  }

  // Datos antes de constraints/índices: las tablas están vacías y así no
  // importa el orden de las FKs entre ellas.
  for (const table of def.tables) {
    const cols = (columnsByTable.get(table.name) || []).filter((c) => c.generated !== 's');
    if (!cols.length) continue;
    const list = cols.map((c) => qi(c.name)).join(', ');
    // Los enums son por schema: el de la plantilla y el del clon son tipos
    // distintos sin cast implícito entre ellos -> pasar por texto.
    const selectList = cols
      .map((c) => (rw(c.type) !== c.type ? `${qi(c.name)}::text::${rw(c.type)}` : qi(c.name)))
      .join(', ');
    const where = table.has_tenant_id && table.name !== 'sequelize_migrations' ? ' WHERE tenant_id IS NULL' : '';
    out.push(`INSERT INTO ${T}.${qi(table.name)} (${list}) SELECT ${selectList} FROM ${S}.${qi(table.name)}${where}`);
  }

  const byType = (types) => def.constraints.filter((c) => types.includes(c.type));
  for (const con of byType(['c'])) {
    out.push(`ALTER TABLE ${T}.${qi(con.table_name)} ADD CONSTRAINT ${qi(con.name)} ${rw(con.def)}`);
  }
  for (const con of byType(['p', 'u', 'x'])) {
    out.push(`ALTER TABLE ${T}.${qi(con.table_name)} ADD CONSTRAINT ${qi(con.name)} ${rw(con.def)}`);
  }
  for (const idx of def.indexes) {
    out.push(rw(idx.def));
  }
  for (const con of byType(['f'])) {
    out.push(`ALTER TABLE ${T}.${qi(con.table_name)} ADD CONSTRAINT ${qi(con.name)} ${rw(con.def)}`);
  }

  return out.join(';\n') + ';';
}

// Un CHECK re-creado desde pg_get_constraintdef() es equivalente pero
// Postgres lo vuelve a escribir con los casts en otro lugar, ej.
//   (ARRAY['a'::character varying, 'b'::character varying])::text[]
//   ARRAY[('a'::character varying)::text, ('b'::character varying)::text]
// Para comparar se quitan casts, paréntesis y espacios: columnas,
// operadores y valores siguen intactos.
function normalizeCheck(def) {
  return String(def)
    .replace(/::[a-z_][a-z0-9_ ]*(\(\d+(,\d+)?\))?(\[\])?/gi, '')
    .replace(/[()\s]/g, '');
}

// Firma comparable de la estructura de un schema, con el nombre del schema
// normalizado, para verificar que el clon quedó idéntico a la plantilla.
function signature(def, schema) {
  const norm = makeRewriter(schema, '<schema>');
  const lines = [];
  for (const e of def.enums) lines.push(`enum ${e.name} (${e.labels.join(',')})`);
  for (const t of def.tables) lines.push(`table ${t.name}`);
  for (const c of def.columns) {
    lines.push(`column ${c.table_name}.${c.name} ${norm(c.type)} nn=${c.not_null} gen=${c.generated || ''} def=${norm(c.default_expr)} coll=${c.collation || ''}`);
  }
  for (const c of def.constraints) {
    lines.push(`constraint ${c.table_name}.${c.name} ${c.type} ${c.type === 'c' ? normalizeCheck(norm(c.def)) : norm(c.def)}`);
  }
  for (const i of def.indexes) lines.push(`index ${i.name} ${norm(i.def)}`);
  return new Set(lines);
}

/**
 * Clona sourceSchema en targetSchema dentro de una transacción.
 * targetSchema no debe tener tablas (puede no existir o existir vacío).
 * Lanza error (y no deja nada creado) si no puede clonar fielmente.
 *
 * @param {import('sequelize').Sequelize} sequelize  conexión directa (no pooler)
 * @returns {Promise<{tables:number, ms:number}>}
 */
async function cloneTenantSchema(sequelize, sourceSchema, targetSchema) {
  const started = Date.now();
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL search_path TO pg_catalog', { transaction });

    const source = await readDefinition(sequelize, transaction, sourceSchema);
    if (!source) throw new Error(`La plantilla "${sourceSchema}" no existe`);
    if (source.unsupported.length) {
      throw new Error(`La plantilla tiene objetos que el clonador no copia -- ${source.unsupported.join('; ')}`);
    }

    const existing = await readDefinition(sequelize, transaction, targetSchema);
    if (existing && existing.tables.length) {
      throw new Error(`El schema "${targetSchema}" ya tiene ${existing.tables.length} tablas; el clon solo aplica a schemas vacíos`);
    }

    await sequelize.query(buildCloneSql(source, sourceSchema, targetSchema), { transaction });

    const cloned = await readDefinition(sequelize, transaction, targetSchema);
    const expected = signature(source, sourceSchema);
    const actual = signature(cloned, targetSchema);
    const missing = [...expected].filter((l) => !actual.has(l));
    const extra = [...actual].filter((l) => !expected.has(l));
    if (missing.length || extra.length) {
      throw new Error(
        `El clon de "${targetSchema}" no coincide con la plantilla ` +
        `(${missing.length} faltantes, ${extra.length} sobrantes). ` +
        `Primeras diferencias: ${[...missing.slice(0, 3).map((l) => `- ${l}`), ...extra.slice(0, 3).map((l) => `+ ${l}`)].join(' | ')}`
      );
    }

    return { tables: cloned.tables.length, ms: Date.now() - started };
  });
}

module.exports = { cloneTenantSchema, readDefinition, signature };
