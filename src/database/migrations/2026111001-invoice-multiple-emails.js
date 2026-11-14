'use strict';

// 4.1 — Factura a múltiples correos.
//  - customers.additional_emails: correos adicionales del cliente (además de
//    customers.email, que sigue siendo el principal y el que viaja en el XML).
//  - sales.additional_emails_override: lista propia de ESA factura. NULL = usar
//    la lista actual del cliente; un arreglo (aunque sea vacío) la reemplaza.
//  - sales.email_delivery: registro del último envío del PDF+XML al comprador
//    ({ sent_at, recipients: [{ email, status: 'sent'|'failed', error? }] }).
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS additional_emails JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS additional_emails_override JSONB`);
    await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS email_delivery JSONB`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS email_delivery`);
    await q(`ALTER TABLE sales DROP COLUMN IF EXISTS additional_emails_override`);
    await q(`ALTER TABLE customers DROP COLUMN IF EXISTS additional_emails`);
  },
};
