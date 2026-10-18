// backend/src/services/accounting/thirdParty.service.js
//
// Terceros contables. journal_entry_lines.third_party_id es polimórfico
// (cliente, proveedor o empleado, sin columna de tipo): aquí se centraliza
// cómo resolver nombre / NIT / tipo y cómo buscarlos para los selectores.

const { sequelize } = require('../../config/database');
const { QueryTypes } = require('sequelize');
const { getCurrentSchema } = require('../../config/tenantContext');

const schemaName = () => getCurrentSchema() || 'public';

/**
 * Fragmentos SQL para agregar el tercero a una consulta que ya tiene una
 * columna con el id (ej: `l.third_party_id`). Uso:
 *   SELECT ..., ${thirdPartySelect('tp')} FROM ... ${thirdPartyJoins(schema, 'l.third_party_id', 'tp')}
 */
function thirdPartyJoins(schema, idCol, alias = 'tp') {
  return `
     LEFT JOIN "${schema}"."suppliers" ${alias}_s ON ${alias}_s.id = ${idCol}
     LEFT JOIN "${schema}"."customers" ${alias}_c ON ${alias}_c.id = ${idCol}
     LEFT JOIN "${schema}"."employees" ${alias}_e ON ${alias}_e.id = ${idCol}`;
}

function thirdPartySelect(alias = 'tp', prefix = 'third_party') {
  return `
            COALESCE(
              NULLIF(${alias}_c.business_name, ''), NULLIF(TRIM(CONCAT_WS(' ', ${alias}_c.first_name, ${alias}_c.last_name)), ''),
              NULLIF(${alias}_s.business_name, ''), ${alias}_s.name,
              NULLIF(TRIM(CONCAT_WS(' ', ${alias}_e.first_name, ${alias}_e.first_surname)), '')
            ) AS ${prefix}_name,
            COALESCE(${alias}_c.tax_id, ${alias}_s.tax_id, ${alias}_e.document_number) AS ${prefix}_tax_id,
            CASE WHEN ${alias}_c.id IS NOT NULL THEN 'customer'
                 WHEN ${alias}_s.id IS NOT NULL THEN 'supplier'
                 WHEN ${alias}_e.id IS NOT NULL THEN 'employee' END AS ${prefix}_type`;
}

/**
 * @param {Array<string>} ids
 * @returns {Promise<Map<string, {id, type, name, tax_id}>>}
 */
async function resolveThirdParties(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;
  const schema = schemaName();
  const rows = await sequelize.query(
    `SELECT x.id, ${thirdPartySelect('tp')}
     FROM unnest(ARRAY[:ids]::uuid[]) AS x(id)
     ${thirdPartyJoins(schema, 'x.id', 'tp')}`,
    { replacements: { ids: unique }, type: QueryTypes.SELECT }
  );
  for (const r of rows) {
    if (!r.third_party_type) continue;
    map.set(r.id, { id: r.id, type: r.third_party_type, name: r.third_party_name || '', tax_id: r.third_party_tax_id || '' });
  }
  return map;
}

/**
 * Tercero "principal" de cada asiento: el de la primera línea que tenga uno
 * (en las ventas es el cliente de la cuenta por cobrar, en compras el
 * proveedor, etc.). Si el asiento tiene varios terceros distintos (nómina)
 * se informa cuántos.
 * @returns {Promise<Map<string, {id, type, name, tax_id, count}>>}
 */
async function entryThirdParties(entryIds) {
  const ids = [...new Set((entryIds || []).filter(Boolean))];
  const result = new Map();
  if (!ids.length) return result;
  const schema = schemaName();
  const rows = await sequelize.query(
    `SELECT l.entry_id, l.third_party_id
     FROM "${schema}"."journal_entry_lines" l
     WHERE l.entry_id IN (:ids) AND l.third_party_id IS NOT NULL
     ORDER BY l.entry_id, l.line_order ASC`,
    { replacements: { ids }, type: QueryTypes.SELECT }
  );
  const perEntry = new Map();
  for (const r of rows) {
    if (!perEntry.has(r.entry_id)) perEntry.set(r.entry_id, []);
    const list = perEntry.get(r.entry_id);
    if (!list.includes(r.third_party_id)) list.push(r.third_party_id);
  }
  const resolved = await resolveThirdParties(rows.map(r => r.third_party_id));
  for (const [entryId, list] of perEntry) {
    const first = list.map(id => resolved.get(id)).find(Boolean);
    if (first) result.set(entryId, { ...first, count: list.length });
  }
  return result;
}

/**
 * Búsqueda unificada de terceros (clientes, proveedores, empleados) por
 * nombre, razón social o documento.
 */
async function searchThirdParties(tenantId, q, { limit = 20, types } = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const schema = schemaName();
  const like = `%${term}%`;
  const want = new Set(types && types.length ? types : ['customer', 'supplier', 'employee']);
  const parts = [];
  if (want.has('customer')) {
    parts.push(`SELECT id, 'customer' AS type,
        COALESCE(NULLIF(business_name, ''), TRIM(CONCAT_WS(' ', first_name, last_name))) AS name, tax_id
      FROM "${schema}"."customers"
      WHERE tenant_id = :tenantId AND (
        TRIM(CONCAT_WS(' ', first_name, last_name)) ILIKE :like OR business_name ILIKE :like OR tax_id ILIKE :like)`);
  }
  if (want.has('supplier')) {
    parts.push(`SELECT id, 'supplier' AS type, COALESCE(NULLIF(business_name, ''), name) AS name, tax_id
      FROM "${schema}"."suppliers"
      WHERE tenant_id = :tenantId AND (name ILIKE :like OR business_name ILIKE :like OR tax_id ILIKE :like)`);
  }
  if (want.has('employee')) {
    parts.push(`SELECT id, 'employee' AS type,
        TRIM(CONCAT_WS(' ', first_name, first_surname)) AS name, document_number AS tax_id
      FROM "${schema}"."employees"
      WHERE tenant_id = :tenantId AND (
        TRIM(CONCAT_WS(' ', first_name, first_surname)) ILIKE :like OR document_number ILIKE :like)`);
  }
  if (!parts.length) return [];
  return sequelize.query(
    `SELECT * FROM (${parts.join(' UNION ALL ')}) t ORDER BY name ASC LIMIT :limit`,
    { replacements: { tenantId, like, limit: Math.min(Number(limit) || 20, 50) }, type: QueryTypes.SELECT }
  );
}

/**
 * Agrega third_party_name / third_party_tax_id / third_party_type a filas que
 * tienen `third_party_id` y `entry_id`. Con fallbackToEntry, las líneas sin
 * tercero propio (caja, bancos, ingresos...) toman el tercero principal del
 * asiento y se marcan con third_party_inherited = true: así en el Libro Mayor
 * de Caja se ve quién pagó cada recibo.
 */
async function attachThirdParties(rows, { fallbackToEntry = false } = {}) {
  if (!rows || !rows.length) return rows;
  const lineMap = await resolveThirdParties(rows.map(r => r.third_party_id));
  let entryMap = new Map();
  if (fallbackToEntry) {
    const missing = rows.filter(r => !r.third_party_id || !lineMap.has(r.third_party_id)).map(r => r.entry_id);
    entryMap = await entryThirdParties(missing);
  }
  for (const r of rows) {
    let tp = r.third_party_id ? lineMap.get(r.third_party_id) : null;
    let inherited = false;
    if (!tp && fallbackToEntry) {
      tp = entryMap.get(r.entry_id) || null;
      inherited = !!tp;
    }
    r.third_party_name = tp?.name || '';
    r.third_party_tax_id = tp?.tax_id || '';
    r.third_party_type = tp?.type || null;
    if (fallbackToEntry) r.third_party_inherited = inherited;
  }
  return rows;
}

module.exports = {
  attachThirdParties,
  thirdPartyJoins,
  thirdPartySelect,
  resolveThirdParties,
  entryThirdParties,
  searchThirdParties,
};
