'use strict';

// 'customer_advance_application' (29 caracteres) y 'customer_advance_refund'
// (24 caracteres) no caben en VARCHAR(20) (ver 2026070903-create-accounting-core.js).
// Se amplía a VARCHAR(40) con margen para futuros source_type sin repetir este ajuste.

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE journal_entries ALTER COLUMN source_type TYPE VARCHAR(40)`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE journal_entries ALTER COLUMN source_type TYPE VARCHAR(20)`
    );
  },
};
