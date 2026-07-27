'use strict';

// El modelo WorkOrderItem define `technician_id` (técnico responsable del ítem,
// puede diferir del técnico principal de la OT) pero ninguna migración lo creó
// en la tabla work_order_items — rompía cualquier consulta que incluyera items.
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE work_order_items ADD COLUMN IF NOT EXISTS technician_id UUID REFERENCES users(id) ON DELETE SET NULL`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TABLE work_order_items DROP COLUMN IF EXISTS technician_id`
    );
  },
};
