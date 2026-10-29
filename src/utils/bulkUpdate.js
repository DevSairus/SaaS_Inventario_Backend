// src/utils/bulkUpdate.js
//
// UPDATE de muchas filas por id en UNA query (UPDATE ... FROM (VALUES ...)),
// para no hacer un round-trip a Neon por fila en documentos con muchas líneas.
//
// Los valores se formatean con el tipo de cada atributo del modelo (igual que
// lo haría Model.update: fechas, DATEONLY, DECIMAL...) y la tabla sale del
// modelo, así que respeta el schema del tenant activo. No corre hooks de
// Sequelize: usarlo solo en modelos sin hooks de update que importen.

const { sequelize } = require('../config/database');

const CHUNK = 500;

/**
 * @param {Model} Model
 * @param {Array<object>} rows  cada una con `id` y las columnas a actualizar
 * @param {string[]} columns    columnas a actualizar (deben existir en el modelo)
 */
async function bulkUpdateById(Model, rows, columns, { transaction } = {}) {
  if (!rows.length) return;
  const qg = sequelize.getQueryInterface().queryGenerator;
  const table = qg.quoteTable(Model.getTableName());
  const attrs = Model.rawAttributes;
  // Tipo base sin precisión (DECIMAL(15,2) -> DECIMAL): la columna real puede
  // tener otra escala que la declarada en el modelo (products.average_cost es
  // NUMERIC(15,4) en la BD y DECIMAL(15,2) en el modelo), y la escala la debe
  // aplicar la columna al asignar, como en un UPDATE normal.
  const pgType = (col) => attrs[col].type.toSql().replace(/\(.*\)/, '');
  const updatedAt = Model.options.timestamps ? Model._timestampAttributes?.updatedAt : null;
  const updatedAtField = updatedAt ? attrs[updatedAt]?.field || updatedAt : null;

  // Igual que Model.update: el valor pasa por el _sanitize del tipo (un DATE
  // recibido como 'YYYY-MM-DD' se vuelve Date) y se formatea con la zona
  // horaria de Sequelize. Sin esto, '2026-10-20' en una columna timestamptz
  // quedaba como medianoche de la sesión de la BD y no como medianoche UTC.
  const escapeOpts = { timezone: sequelize.options.timezone };
  const literal = (col, value) => {
    const type = attrs[col].type;
    const clean = typeof type._sanitize === 'function' ? type._sanitize(value) : value;
    return `${qg.escape(clean, attrs[col], escapeOpts)}::${pgType(col)}`;
  };

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map((row) => `(${[
      `${qg.escape(row.id)}::uuid`,
      ...columns.map((col) => (row[col] === null || row[col] === undefined
        ? `NULL::${pgType(col)}`
        : literal(col, row[col]))),
    ].join(', ')})`).join(',\n');
    const sets = columns.map((col) => `${qg.quoteIdentifier(attrs[col].field || col)} = v.${qg.quoteIdentifier(col)}`);
    if (updatedAtField && !columns.includes(updatedAt)) sets.push(`${qg.quoteIdentifier(updatedAtField)} = NOW()`);
    await sequelize.query(
      `UPDATE ${table} AS t SET ${sets.join(', ')}
         FROM (VALUES ${values}) AS v(id, ${columns.map((c) => qg.quoteIdentifier(c)).join(', ')})
        WHERE t.id = v.id`,
      { transaction }
    );
  }
}

module.exports = { bulkUpdateById };
