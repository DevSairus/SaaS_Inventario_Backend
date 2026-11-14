'use strict';

// 3.1 — RUT y Cámara de Comercio del proveedor.
//  - Nuevos tipos de adjunto: 'rut' y 'chamber_of_commerce'.
//  - attachments.valid_until: vigencia del documento (la Cámara de Comercio
//    pierde validez; el RUT no la usa). DATE, opcional.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.

const KINDS = [
  'invoice_pdf', 'invoice_xml', 'payment_proof', 'delivery_note', 'photo',
  'contract', 'quote', 'rut', 'chamber_of_commerce', 'other',
];
const OLD_KINDS = ['invoice_pdf', 'invoice_xml', 'payment_proof', 'delivery_note', 'photo', 'contract', 'quote', 'other'];

const list = (arr) => arr.map((k) => `'${k}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check`);
      await q(`ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN (${list(KINDS)}))`);
      await q(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS valid_until DATE`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`UPDATE attachments SET kind = 'other' WHERE kind IN ('rut', 'chamber_of_commerce')`);
      await q(`ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check`);
      await q(`ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN (${list(OLD_KINDS)}))`);
      await q(`ALTER TABLE attachments DROP COLUMN IF EXISTS valid_until`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
