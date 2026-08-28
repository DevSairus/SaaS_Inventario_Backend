'use strict';

// §3 del plan (Opción B): el Documento Soporte NO es una transacción nueva
// — es un artefacto de cumplimiento tributario sobre una Purchase que ya
// existe y ya generó su movimiento de inventario/contable. Se agregan los
// campos dian_* directo sobre `purchases`, espejo de los que ya tiene `Sale`
// para factura. `cuds` (no `cufe`) a propósito: mismo principio de hash que
// CUFE pero algoritmo/orden de concatenación distintos — ver §4 del plan,
// pendiente del Anexo Técnico antes de implementarse.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE purchases
        ADD COLUMN IF NOT EXISTS requires_support_document BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS dian_status VARCHAR(30) NOT NULL DEFAULT 'not_applicable',
        ADD COLUMN IF NOT EXISTS support_document_number VARCHAR(50),
        ADD COLUMN IF NOT EXISTS cuds VARCHAR(255),
        ADD COLUMN IF NOT EXISTS dian_response JSONB,
        ADD COLUMN IF NOT EXISTS dian_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS dian_accepted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS dian_error_message TEXT
    `);
    console.log('[Migration] purchases: columnas dian_* + requires_support_document agregadas');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE purchases
        DROP COLUMN IF EXISTS requires_support_document,
        DROP COLUMN IF EXISTS dian_status,
        DROP COLUMN IF EXISTS support_document_number,
        DROP COLUMN IF EXISTS cuds,
        DROP COLUMN IF EXISTS dian_response,
        DROP COLUMN IF EXISTS dian_sent_at,
        DROP COLUMN IF EXISTS dian_accepted_at,
        DROP COLUMN IF EXISTS dian_error_message
    `);
  },
};
