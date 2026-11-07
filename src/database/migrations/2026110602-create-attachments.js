'use strict';

// Adjuntos genéricos ("cero papel", Fase 2 del módulo Proyectos): soportes de
// compras, gastos, traslados, proyectos, ventas y pagos. El archivo nunca
// queda en una URL pública: Cloudinary 'authenticated' o, sin Cloudinary,
// backend/private_uploads/attachments (ver services/attachments/attachmentStorage.js).
//
// Sin calificar con esquema (salvo tenants/users, que viven en public):
// migrateAllTenantSchemas corre esto con el search_path de cada tenant.

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
    try {
      await q(`
        CREATE TABLE IF NOT EXISTS attachments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID NOT NULL REFERENCES "public"."tenants"(id) ON DELETE CASCADE ON UPDATE CASCADE,
          entity_type VARCHAR(30) NOT NULL,
          entity_id UUID NOT NULL,
          kind VARCHAR(30) NOT NULL DEFAULT 'other'
            CHECK (kind IN ('invoice_pdf', 'invoice_xml', 'payment_proof', 'delivery_note', 'photo', 'contract', 'quote', 'other')),
          description VARCHAR(255),
          file_name VARCHAR(255) NOT NULL,
          mime_type VARCHAR(120),
          size_bytes INTEGER,
          sha256 VARCHAR(64),
          storage VARCHAR(20) NOT NULL CHECK (storage IN ('cloudinary', 'local')),
          storage_key VARCHAR(500) NOT NULL,
          resource_type VARCHAR(20),
          format VARCHAR(20),
          uploaded_by UUID REFERENCES "public"."users"(id) ON DELETE SET NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments (tenant_id, entity_type, entity_id)`);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS attachments`);
  },
};
