'use strict';

// Aprobación parcial de cotizaciones (Sale, document_type='cotizacion') --
// mismo patrón que WorkOrderItem.approval_status/rejection_reason en
// backend/src/models/workshop/WorkOrderItem.js. Default 'aprobado' para que
// los ítems de ventas normales (sin flujo de cotización) se comporten
// exactamente igual que antes de esta funcionalidad.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('sale_items');

    if (!existingColumns.approval_status) {
      await queryInterface.addColumn('sale_items', 'approval_status', {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'aprobado',
      });
    }
    if (!existingColumns.rejection_reason) {
      await queryInterface.addColumn('sale_items', 'rejection_reason', {
        type: Sequelize.STRING(255),
        allowNull: true,
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('sale_items', 'rejection_reason');
    await queryInterface.removeColumn('sale_items', 'approval_status');
  },
};
