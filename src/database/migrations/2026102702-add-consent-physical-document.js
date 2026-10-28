'use strict';

// Escaneo/foto del formato firmado en papel de una autorización registrada
// como 'physical' (ver consents.controller.js#registerPhysical):
// { storage: 'cloudinary'|'local', public_id|path, resource_type, format,
//   filename, mime, size, uploaded_at }. Privado: en Cloudinary va como
// type 'authenticated' y solo se entrega con enlace temporal firmado.
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_consents ADD COLUMN IF NOT EXISTS physical_document JSONB`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TABLE customer_consents DROP COLUMN IF EXISTS physical_document`);
  },
};
