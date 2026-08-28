'use strict';

// Mismo patrón nullable-FK que ya usa dian_events.sale_id / .purchase_id
// (ver 2026082807-add-purchase-id-to-dian-events.js) — no se toca lo
// existente, solo se agrega el enlace al nuevo origen unificado. Sirve
// tanto para el evento del documento principal como para el de una nota de
// ajuste (support_document_adjustments no tiene su propia bitácora
// separada, reutiliza dian_events).
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE dian_events
        ADD COLUMN IF NOT EXISTS support_document_id UUID NULL
        REFERENCES support_documents(id)
    `);
    await queryInterface.addIndex('dian_events', ['support_document_id']);
    console.log('[Migration] dian_events: columna support_document_id agregada');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE dian_events DROP COLUMN IF EXISTS support_document_id`);
  },
};
