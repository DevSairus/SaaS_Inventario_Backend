'use strict';

// Enlace público al PDF de un pedido a proveedor (GET
// /api/public/order-lists/:token/pdf). Se usa al compartir el pedido por
// WhatsApp sin la Cloud API: un enlace wa.me no puede adjuntar archivos, así
// que el mensaje lleva el enlace al PDF en vez de la lista de ítems. Se
// genera la primera vez que se comparte y no vence; el PDF muestra el
// contenido actual del pedido (y no lleva precios).
//
// Sin calificar con esquema: migrateAllTenantSchemas corre esto con el
// search_path de cada tenant.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE IF EXISTS supplier_order_lists ADD COLUMN IF NOT EXISTS share_token UUID
    `);
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF to_regclass('supplier_order_lists') IS NOT NULL THEN
          CREATE UNIQUE INDEX IF NOT EXISTS supplier_order_lists_share_token_idx
            ON supplier_order_lists (share_token) WHERE share_token IS NOT NULL;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS supplier_order_lists_share_token_idx');
    await queryInterface.sequelize.query('ALTER TABLE IF EXISTS supplier_order_lists DROP COLUMN IF EXISTS share_token');
  },
};
