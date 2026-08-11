'use strict';

// Ciclo de vida propio de las cotizaciones (document_type='cotizacion'),
// separado del status genérico de venta (draft/pending/completed/cancelled).
// El cliente aprueba/rechaza desde la página pública (/public/quote/:token)
// -- mismo patrón de captura que WorkOrderQuoteRequest (approved_by_name,
// approved_ip) en backend/src/models/workshop/WorkOrderQuoteRequest.js.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existingColumns = await queryInterface.describeTable('sales');

    if (!existingColumns.quote_status) {
      await queryInterface.addColumn('sales', 'quote_status', {
        type: Sequelize.ENUM('borrador', 'enviada', 'aprobada', 'rechazada', 'vencida'),
        allowNull: true,
        defaultValue: null,
      });
    }
    if (!existingColumns.quote_approved_by_name) {
      await queryInterface.addColumn('sales', 'quote_approved_by_name', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!existingColumns.quote_approved_by_document) {
      await queryInterface.addColumn('sales', 'quote_approved_by_document', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!existingColumns.quote_approved_ip) {
      await queryInterface.addColumn('sales', 'quote_approved_ip', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!existingColumns.quote_responded_at) {
      await queryInterface.addColumn('sales', 'quote_responded_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    await queryInterface.addIndex('sales', ['tenant_id', 'quote_status'], {
      name: 'sales_tenant_id_quote_status_idx',
    }).catch(() => {});
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('sales', 'sales_tenant_id_quote_status_idx').catch(() => {});
    await queryInterface.removeColumn('sales', 'quote_responded_at');
    await queryInterface.removeColumn('sales', 'quote_approved_ip');
    await queryInterface.removeColumn('sales', 'quote_approved_by_document');
    await queryInterface.removeColumn('sales', 'quote_approved_by_name');
    await queryInterface.removeColumn('sales', 'quote_status');
  },
};
