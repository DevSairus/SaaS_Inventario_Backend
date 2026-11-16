'use strict';

// Código UNSPSC del producto (Anexo Técnico FE 1.9, tabla 13.3.5: schemeID
// 001, schemeAgencyID 10). Si está, la factura electrónica identifica la
// línea con UNSPSC; si no, con la codificación propia (999 + SKU). El
// catálogo para buscarlo vive en src/data/unspsc_v14.tsv.gz.
//
// Sin calificar con esquema: corre en cada schema de tenant.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'ALTER TABLE products ADD COLUMN IF NOT EXISTS unspsc_code VARCHAR(8)'
    );
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE products DROP COLUMN IF EXISTS unspsc_code');
  },
};
