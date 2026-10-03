'use strict';

// Movimientos bancarios idénticos legítimos.
//
// bank_transactions_dedupe_idx (2026091601) era único por (cuenta, fecha,
// monto, referencia, descripción): eso impide guardar dos movimientos reales
// iguales el mismo día — muy común en extractos (ej. dos "TRANSFERENCIA DESDE
// NEQUI" de 230.000 el mismo día en Bancolombia, que no trae referencia). El
// import fallaba con "llave duplicada viola restricción de unicidad".
//
// `occurrence` numera las repeticiones (1, 2, ...) de un mismo movimiento
// dentro de la cuenta, y entra al índice único: re-importar el mismo
// extracto sigue sin duplicar (bankImport.controller crea solo las
// ocurrencias que faltan) y los repetidos reales sí se guardan.

module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS occurrence INTEGER NOT NULL DEFAULT 1`);
    await q.query(`DROP INDEX IF EXISTS bank_transactions_dedupe_idx`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_dedupe_occ_idx ON bank_transactions
         (bank_account_id, transaction_date, amount, COALESCE(reference, ''), COALESCE(description, ''), occurrence)`
    );
    console.log('[Migration] bank_transactions.occurrence agregada; índice de deduplicación incluye la ocurrencia');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`DROP INDEX IF EXISTS bank_transactions_dedupe_occ_idx`);
    // Solo se puede restaurar el índice anterior si no hay repetidos.
    await q.query(`DELETE FROM bank_transactions WHERE occurrence > 1`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_dedupe_idx ON bank_transactions
         (bank_account_id, transaction_date, amount, COALESCE(reference, ''), COALESCE(description, ''))`
    );
    await q.query(`ALTER TABLE bank_transactions DROP COLUMN IF EXISTS occurrence`);
  },
};
