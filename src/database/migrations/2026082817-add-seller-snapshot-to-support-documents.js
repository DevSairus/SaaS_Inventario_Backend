'use strict';

// Fase 5 — persiste el objeto `seller` (misma forma que produce
// dianKit.buildSellerFromSupplier/buildSellerFromAdHoc) con el que se generó
// cada Documento Soporte. Antes de esta migración ese dato se armaba al
// vuelo en dianService.js#sendSupportDocumentForExpense y se descartaba
// después del envío -- si el origen era un Expense con vendedor ad-hoc (sin
// Supplier real), no quedaba ningún registro de quién era el vendedor, lo
// que hacía imposible generar una Nota de Ajuste después (ver
// dian.controller.js#createSupportDocumentAdjustment, limitación documentada
// en LEEME-Fase4.md).
//
// Nullable y sin backfill: los Documentos Soporte generados ANTES de esta
// migración simplemente no van a tener snapshot -- si alguno de esos
// necesita una Nota de Ajuste y no tiene Supplier real vinculado, seguirá
// bloqueado con el mismo mensaje de error de antes (no hay de dónde sacar
// los datos del vendedor retroactivamente).
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE support_documents
        ADD COLUMN IF NOT EXISTS seller_snapshot JSONB
    `);
    console.log('[Migration] support_documents: columna seller_snapshot agregada');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE support_documents
        DROP COLUMN IF EXISTS seller_snapshot
    `);
  },
};
