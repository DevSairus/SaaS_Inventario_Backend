'use strict';

// La migración 2026070611-fix-full-schema-audit.js agregó `product_settlement_id`
// a work_orders pero omitió `product_settled_at`, que el modelo WorkOrder también
// define (liquidación de comisiones de repuestos) — esto rompía la creación de OTs.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS product_settled_at TIMESTAMP WITH TIME ZONE`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE work_orders DROP COLUMN IF EXISTS product_settled_at`
    );
  },
};
