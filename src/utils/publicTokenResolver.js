// backend/src/utils/publicTokenResolver.js
//
// Los endpoints PÚBLICOS (sin auth) no tienen tenantMiddleware que fije el
// schema -- solo traen un token. Esto resuelve a qué schema pertenece el
// registro dueño del token: primero "public" (tenants legado) y, si no
// aparece ahí, cada schema de un tenant ya cortado. Misma estrategia que
// resolveWorkOrderSchemaByToken (workOrders.controller.js), generalizada
// para cualquier tabla/columna de token.
const { sequelize } = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `table` y `column` se interpolan en el SQL -- solo aceptar identificadores
// simples fijados por el código, nunca algo que venga del request.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * @returns {Promise<{ id: string, schemaName: string|null } | null>}
 *   schemaName null = tenant legado en "public" (runWithTenantSchema(null)
 *   deja el comportamiento por defecto).
 */
const tenantIdColumnCache = new Map();
async function publicHasTenantId(table) {
  if (!tenantIdColumnCache.has(table)) {
    const [rows] = await sequelize.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = :table AND column_name = 'tenant_id' LIMIT 1`,
      { replacements: { table } }
    );
    tenantIdColumnCache.set(table, rows.length > 0);
  }
  return tenantIdColumnCache.get(table);
}

async function resolveRecordSchemaByToken({ table, column, token }) {
  if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) {
    throw new Error(`Identificador inválido en resolveRecordSchemaByToken: ${table}.${column}`);
  }
  // Un token que no es UUID revienta el cast de Postgres -- es simplemente
  // un link inválido.
  if (!UUID_RE.test(String(token || ''))) return null;

  // En public solo cuentan los tenants sin cortar: tras el corte, public
  // conserva la copia vieja de sus filas hasta la limpieza y no es la que
  // está en uso (un link viejo abría -- y aprobaba sobre -- esa copia).
  const legacyOnly = (await publicHasTenantId(table))
    ? ' AND tenant_id IN (SELECT id FROM "public"."tenants" WHERE schema_name IS NULL)'
    : '';
  const [publicRows] = await sequelize.query(
    `SELECT id FROM "public"."${table}" WHERE ${column} = :token${legacyOnly} LIMIT 1`,
    { replacements: { token } }
  );
  if (publicRows[0]) return { id: publicRows[0].id, schemaName: null };

  const [tenants] = await sequelize.query(
    'SELECT schema_name FROM "public"."tenants" WHERE schema_name IS NOT NULL'
  );
  for (const { schema_name } of tenants) {
    const [rows] = await sequelize.query(
      `SELECT id FROM "${schema_name}"."${table}" WHERE ${column} = :token LIMIT 1`,
      { replacements: { token } }
    );
    if (rows[0]) return { id: rows[0].id, schemaName: schema_name };
  }
  return null;
}

module.exports = { resolveRecordSchemaByToken, UUID_RE };
