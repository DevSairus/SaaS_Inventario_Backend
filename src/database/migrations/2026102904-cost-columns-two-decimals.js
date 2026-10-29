'use strict';

// Costos a 2 decimales (en pesos los centavos de más no aportan nada): costo
// promedio y último costo del producto, costo unitario de movimientos y
// compras, y los costos de las alertas de costo. Cantidades y stock se quedan
// con 4 decimales a propósito: hay productos por peso (kg) y 0,125 kg no
// puede volverse 0,13. Las tasas (ReteICA, ARL, tasa de cambio...) tampoco
// se tocan.
//
// Redondea los datos existentes (no se puede deshacer). Las vistas que usan
// estas columnas (en public: v_products_full, v_warehouse_stock_detail)
// impiden cambiar el tipo: se guardan, se borran y se vuelven a crear igual.
//
// Sin calificar con esquema: corre en public y en cada tenant con su
// search_path; current_schema() es el schema donde está corriendo.
const COST_COLUMNS = [
  ['products', 'average_cost'],
  ['products', 'last_purchase_cost'],
  ['inventory_movements', 'unit_cost'],
  ['inventory_movements', 'average_cost_before'],
  ['inventory_movements', 'average_cost_after'],
  ['purchase_items', 'unit_cost'],
  ['purchase_details', 'unit_cost'],
  ['product_warehouse_stock', 'average_cost'],
  ['cost_alerts', 'previous_cost'],
  ['cost_alerts', 'new_cost'],
];

async function changeScale(queryInterface, fromScale, toScale) {
  const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, type: queryInterface.sequelize.QueryTypes.SELECT });
  const [{ schema }] = await q('SELECT current_schema() AS schema');
  const pairs = COST_COLUMNS.map(([t, c]) => `('${t}', '${c}')`).join(', ');

  const targets = await q(`
    SELECT table_name, column_name, numeric_precision
      FROM information_schema.columns
     WHERE table_schema = :schema AND data_type = 'numeric' AND numeric_scale = :fromScale
       AND (table_name, column_name) IN (${pairs})
  `, { schema, fromScale });
  if (targets.length === 0) return;

  const views = await q(`
    SELECT DISTINCT c.oid, n.nspname AS view_schema, c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
      FROM information_schema.view_column_usage u
      JOIN pg_class c ON c.relname = u.view_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = u.view_schema
     WHERE u.table_schema = :schema AND (u.table_name, u.column_name) IN (${pairs})
  `, { schema });

  const run = (sql) => queryInterface.sequelize.query(sql);
  for (const v of views) await run(`DROP VIEW "${v.view_schema}"."${v.view_name}"`);
  for (const t of targets) {
    await run(`ALTER TABLE "${schema}"."${t.table_name}"
      ALTER COLUMN "${t.column_name}" TYPE NUMERIC(${t.numeric_precision}, ${toScale})
      USING round("${t.column_name}", ${toScale})`);
  }
  for (const v of views) await run(`CREATE VIEW "${v.view_schema}"."${v.view_name}" AS ${v.definition}`);
}

module.exports = {
  up: (queryInterface) => changeScale(queryInterface, 4, 2),
  // Vuelve el tipo a 4 decimales; los decimales ya redondeados no vuelven.
  down: (queryInterface) => changeScale(queryInterface, 2, 4),
};
