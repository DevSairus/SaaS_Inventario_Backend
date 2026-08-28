'use strict';

// Se retiran de `purchases` porque ahora viven en `support_documents`
// (migradas en 2026082810). `requires_support_document` SÍ se conserva:
// es un flag de intención capturado por el usuario al crear/editar la
// compra, no un dato DIAN, así que sigue viviendo en la tabla origen.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE purchases
        DROP COLUMN IF EXISTS dian_status,
        DROP COLUMN IF EXISTS support_document_number,
        DROP COLUMN IF EXISTS cuds,
        DROP COLUMN IF EXISTS dian_response,
        DROP COLUMN IF EXISTS dian_sent_at,
        DROP COLUMN IF EXISTS dian_accepted_at,
        DROP COLUMN IF EXISTS dian_error_message
    `);
    console.log('[Migration] purchases: columnas dian_* retiradas (viven en support_documents)');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE purchases
        ADD COLUMN IF NOT EXISTS dian_status VARCHAR(30) NOT NULL DEFAULT 'not_applicable',
        ADD COLUMN IF NOT EXISTS support_document_number VARCHAR(50),
        ADD COLUMN IF NOT EXISTS cuds VARCHAR(255),
        ADD COLUMN IF NOT EXISTS dian_response JSONB,
        ADD COLUMN IF NOT EXISTS dian_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS dian_accepted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS dian_error_message TEXT
    `);
    // Nota: el down no restaura los datos (ya viven en support_documents).
  },
};
