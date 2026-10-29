'use strict';

// Índices de rendimiento (auditoría 2026-10-29).
//
// 1. Trigram sobre la expresión de búsqueda de productos, ventas, clientes y
//    vehículos: las búsquedas '%palabra%' recorrían la tabla completa (en el
//    POS, en cada tecla). La expresión sale de utils/searchText.js, la misma
//    que usan los controllers -- tienen que ser idénticas o Postgres no usa
//    el índice.
// 2. journal_entry_lines(third_party_id): Libro Auxiliar por tercero, filtro
//    por tercero del listado de asientos y saldos de provisiones de nómina
//    recorrían todas las líneas.
// 3. users(lower(email)): el login busca por lower(email); el índice único
//    sobre email no sirve para esa expresión. users solo existe en public.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant (SOLO el schema del tenant, sin public), por eso
// el operador de pg_trgm va calificado: public.gin_trgm_ops.
const { searchExpression } = require('../../utils/searchText');

const SEARCH_TABLES = ['products', 'sales', 'customers', 'vehicles'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public`);

    for (const table of SEARCH_TABLES) {
      await q(`
        DO $$ BEGIN
          IF to_regclass('${table}') IS NOT NULL THEN
            CREATE INDEX IF NOT EXISTS idx_${table}_search_trgm ON ${table}
              USING gin ((${searchExpression(table)}) public.gin_trgm_ops);
          END IF;
        END $$
      `);
    }

    await q(`
      DO $$ BEGIN
        IF to_regclass('journal_entry_lines') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_third_party
            ON journal_entry_lines (third_party_id, account_id)
            WHERE third_party_id IS NOT NULL;
        END IF;
      END $$
    `);

    await q(`
      DO $$ BEGIN
        IF to_regclass('users') IS NOT NULL THEN
          CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (lower(email));
        END IF;
      END $$
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const table of SEARCH_TABLES) {
      await q(`DROP INDEX IF EXISTS idx_${table}_search_trgm`);
    }
    await q(`DROP INDEX IF EXISTS idx_journal_entry_lines_third_party`);
    await q(`DROP INDEX IF EXISTS idx_users_lower_email`);
  },
};
