'use strict';

// Anticipo de cliente nacido de abonos de una OT: al cancelarla, o por el
// excedente de los abonos sobre el total facturado. El dinero ya entró (y
// si el abono tenía asiento propio, ya está en 2805), por eso estos
// anticipos no se pueden anular, solo devolver o aplicar.

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE customer_advances ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES work_orders(id) ON DELETE SET NULL ON UPDATE CASCADE`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE customer_advances DROP COLUMN IF EXISTS work_order_id`);
  },
};
