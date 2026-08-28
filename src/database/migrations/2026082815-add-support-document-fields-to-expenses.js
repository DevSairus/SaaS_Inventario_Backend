'use strict';

// Habilita a `expenses` (Tesorería) para generar Documento Soporte, igual
// que `purchases`:
//   - requires_support_document: flag de intención, espejo de
//     purchases.requires_support_document.
//   - subtotal/tax_rate/tax_amount: hoy Expense solo tiene total_amount
//     sin desglose — el Documento Soporte necesita base + IVA por
//     separado. total_amount pasa a ser subtotal + tax_amount (se
//     recalcula en el modelo, ver Expense.js).
//   - retefuente_rate/amount, reteiva_rate/amount, reteica_rate/amount,
//     total_retentions: mismo set que ya existe en `purchases` desde
//     2026070302-add-multi-tax-system.js (Fase C) — Expense no lo tenía
//     porque nunca se planeó que un gasto necesitara retención declarada,
//     pero honorarios/arriendo a independientes sí la generan.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE expenses
        ADD COLUMN IF NOT EXISTS requires_support_document BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS retefuente_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS retefuente_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reteiva_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reteiva_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reteica_rate DECIMAL(5,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reteica_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_retentions DECIMAL(15,2) NOT NULL DEFAULT 0
    `);

    // Backfill: gastos ya existentes no tienen desglose — se asume
    // subtotal = total_amount, sin IVA ni retención (comportamiento
    // idéntico al que tenían antes de esta migración; el usuario ajustará
    // caso a caso si alguno sí requería Documento Soporte retroactivo).
    await q.query(`
      UPDATE expenses SET subtotal = total_amount WHERE subtotal = 0
    `);

    console.log('[Migration] expenses: columnas de IVA, retenciones y requires_support_document agregadas');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE expenses
        DROP COLUMN IF EXISTS requires_support_document,
        DROP COLUMN IF EXISTS subtotal,
        DROP COLUMN IF EXISTS tax_rate,
        DROP COLUMN IF EXISTS tax_amount,
        DROP COLUMN IF EXISTS retefuente_rate,
        DROP COLUMN IF EXISTS retefuente_amount,
        DROP COLUMN IF EXISTS reteiva_rate,
        DROP COLUMN IF EXISTS reteiva_amount,
        DROP COLUMN IF EXISTS reteica_rate,
        DROP COLUMN IF EXISTS reteica_amount,
        DROP COLUMN IF EXISTS total_retentions
    `);
  },
};
