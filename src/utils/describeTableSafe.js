// backend/src/utils/describeTableSafe.js
//
// Sustituto de queryInterface.describeTable() para usar en migraciones que
// tocan tablas replicadas en cada schema de tenant (tenant_meta_configs,
// meta_config -- ver docs/WHATSAPP.md §3 y §12: viven "de verdad" en public,
// pero el propagador de migraciones a schemas de tenant las vuelve a crear
// como copia fantasma en cada tenant_<slug>, aunque el código nunca las lee
// ahí -- ver PUBLIC_SCHEMA_MODELS en registerTenantSchemaHooks.js).
//
// El describeTable() de Sequelize arma un JOIN contra pg_catalog para
// resolver comentarios de columna (pg_statio_all_tables + pg_description)
// que correlaciona solo por nombre de tabla, sin filtrar por schema. En
// cuanto el mismo nombre de tabla existe en 2+ schemas Y ambas copias tienen
// un COMMENT ON COLUMN en la misma posición (exactamente lo que pasa acá,
// porque la migración que agrega el comment se replica a cada tenant), esa
// subconsulta dejar de ser 1:1 y Postgres tira "more than one row returned
// by a subquery used as an expression" -- rompiendo la migración para
// SIEMPRE en cualquier schema de tenant, no solo para esta tabla.
//
// Esta función evita el problema por completo: consulta information_schema
// directo, filtrando por el schema efectivo (current_schema(), que ya
// resuelve al tenant correcto vía el search_path que fija el migrador).
async function describeTableSafe(queryInterface, tableName) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = :tableName`,
    { replacements: { tableName } }
  );
  if (!rows.length) return null;
  const desc = {};
  for (const row of rows) desc[row.column_name] = true;
  return desc;
}

module.exports = { describeTableSafe };
