'use strict';

// Soporte para "convertir cotización en Orden de Trabajo" (solo tenants con
// módulo Taller). work_orders.quote_sale_id es distinto de work_orders.sale_id
// (que es la remisión/factura generada AL CERRAR la OT) — este apunta hacia
// atrás, a la cotización que la originó. sales.converted_to_work_order_id
// evita convertir la misma cotización dos veces.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Guard: algunos schemas ya traen estas columnas de fábrica (baseline).
    const workOrderColumns = await queryInterface.describeTable('work_orders');
    if (!workOrderColumns.quote_sale_id) {
      await queryInterface.addColumn('work_orders', 'quote_sale_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'sales', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Cotización (sales.document_type=cotizacion) desde la que se convirtió esta OT, si aplica',
      });
    }

    const salesColumns = await queryInterface.describeTable('sales');
    if (!salesColumns.converted_to_work_order_id) {
      await queryInterface.addColumn('sales', 'converted_to_work_order_id', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'work_orders', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'OT generada al convertir esta cotización, si ya fue convertida',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('work_orders', 'quote_sale_id');
    await queryInterface.removeColumn('sales', 'converted_to_work_order_id');
  },
};
