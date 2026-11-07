'use strict';

// Dimensión de proyecto en asientos anteriores a 2026110609: marca las líneas
// de los asientos automáticos cuyo documento origen tiene proyecto (mismo
// criterio que autoEntries.service.js: todas las líneas del asiento). Solo
// llena líneas sin proyecto; no toca montos ni estados.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.

const SOURCES = [
  // [source_type, subconsulta que da el proyecto del documento origen]
  ['sale', `SELECT s.project_id FROM sales s WHERE s.id = e.source_id`],
  ['purchase', `SELECT p.project_id FROM purchases p WHERE p.id = e.source_id`],
  ['expense', `SELECT x.project_id FROM expenses x WHERE x.id = e.source_id`],
  ['credit_note', `SELECT COALESCE(n.project_id, r.project_id) FROM sales n LEFT JOIN sales r ON r.id = n.reference_sale_id WHERE n.id = e.source_id`],
  ['debit_note', `SELECT COALESCE(n.project_id, r.project_id) FROM sales n LEFT JOIN sales r ON r.id = n.reference_sale_id WHERE n.id = e.source_id`],
  ['customer_return', `SELECT s.project_id FROM customer_returns cr JOIN sales s ON s.id = cr.sale_id WHERE cr.id = e.source_id`],
  ['supplier_return', `SELECT p.project_id FROM supplier_returns sr JOIN purchases p ON p.id = sr.purchase_id WHERE sr.id = e.source_id`],
];

module.exports = {
  up: async (queryInterface) => {
    const [[ready]] = await queryInterface.sequelize.query(`
      SELECT to_regclass('journal_entries') IS NOT NULL AND to_regclass('projects') IS NOT NULL
         AND EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = current_schema() AND table_name = 'journal_entry_lines' AND column_name = 'project_id') AS ok
    `);
    if (!ready?.ok) return;
    for (const [sourceType, projectOf] of SOURCES) {
      // Las tablas de devoluciones pueden no existir en un schema muy viejo.
      const table = sourceType === 'customer_return' ? 'customer_returns' : sourceType === 'supplier_return' ? 'supplier_returns' : null;
      if (table) {
        // eslint-disable-next-line no-await-in-loop
        const [[exists]] = await queryInterface.sequelize.query(`SELECT to_regclass('${table}') IS NOT NULL AS ok`);
        if (!exists.ok) continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.sequelize.query(`
        UPDATE journal_entry_lines l
           SET project_id = src.project_id
          FROM (
            SELECT e.id AS entry_id, (${projectOf}) AS project_id
              FROM journal_entries e
             WHERE e.source_type = :sourceType AND e.source_id IS NOT NULL
          ) src
         WHERE l.entry_id = src.entry_id
           AND src.project_id IS NOT NULL
           AND l.project_id IS NULL
      `, { replacements: { sourceType } });
    }
  },

  down: async () => {
    // Sin reversa: no se distingue lo marcado aquí de lo marcado al crear el asiento.
  },
};
