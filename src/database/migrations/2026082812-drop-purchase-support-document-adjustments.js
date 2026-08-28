'use strict';

// Se retira una vez confirmado que 2026082811 ya migró todo su contenido a
// support_document_adjustments.
module.exports = {
  async up(queryInterface) {
    await queryInterface.dropTable('purchase_support_document_adjustments');
    console.log('[Migration] purchase_support_document_adjustments eliminada (migrada a support_document_adjustments)');
  },

  async down(queryInterface, Sequelize) {
    // Recreación mínima de la estructura (sin datos — ya viven en
    // support_document_adjustments). Solo para poder revertir en desarrollo.
    await queryInterface.createTable('purchase_support_document_adjustments', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: { type: Sequelize.UUID, allowNull: false },
      purchase_id: { type: Sequelize.UUID, allowNull: false },
      adjustment_type: { type: Sequelize.STRING(10), allowNull: false },
      reason: { type: Sequelize.TEXT },
      items: { type: Sequelize.JSONB, defaultValue: [] },
      subtotal: { type: Sequelize.DECIMAL(15, 2), defaultValue: 0 },
      tax_amount: { type: Sequelize.DECIMAL(15, 2), defaultValue: 0 },
      total_amount: { type: Sequelize.DECIMAL(15, 2), defaultValue: 0 },
      adjustment_number: { type: Sequelize.STRING(50) },
      cuds: { type: Sequelize.STRING(255) },
      dian_status: { type: Sequelize.STRING(30) },
      dian_response: { type: Sequelize.JSONB },
      dian_sent_at: { type: Sequelize.DATE },
      dian_accepted_at: { type: Sequelize.DATE },
      dian_error_message: { type: Sequelize.TEXT },
      created_by: { type: Sequelize.UUID },
      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
    });
  },
};
