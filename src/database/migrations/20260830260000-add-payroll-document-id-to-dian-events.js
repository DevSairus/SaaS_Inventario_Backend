'use strict';

// Mismo patrón nullable-FK que support_document_id
// (2026082814-add-support-document-id-to-dian-events.js) — sirve tanto
// para el evento del documento de nómina principal como para el de su
// nota de ajuste (payroll_document_adjustments no tiene bitácora propia,
// reutiliza dian_events igual que support_document_adjustments).
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE dian_events
        ADD COLUMN IF NOT EXISTS payroll_document_id UUID NULL
        REFERENCES payroll_documents(id)
    `);
    await queryInterface.addIndex('dian_events', ['payroll_document_id']);
    console.log('[Migration] dian_events: columna payroll_document_id agregada');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`ALTER TABLE dian_events DROP COLUMN IF EXISTS payroll_document_id`);
  },
};
