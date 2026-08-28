'use strict';

// §3 del plan: "Nota de Ajuste al Documento Soporte" — cumple el rol de
// crédito/débito pero es un tipo de documento DIAN distinto. A diferencia
// del gap encontrado en createAndSendCreditNote (nota crédito de factura sin
// FK real al documento original, solo enlazada por texto libre en `notes`),
// acá `purchase_id` es una FK real desde el día 1.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('purchase_support_document_adjustments', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      purchase_id: {
        type: Sequelize.UUID,
        allowNull: false,
        comment: 'FK real al Documento Soporte original (Purchase) — no texto libre.',
        references: { model: 'purchases', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      adjustment_type: {
        type: Sequelize.STRING(10),
        allowNull: false,
        validate: { isIn: [['credit', 'debit']] },
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      items: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      subtotal: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },
      tax_amount: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },
      total_amount: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
      },
      adjustment_number: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Prefijo + consecutivo (numeración propia, igual que NC/ND de venta).',
      },
      cuds: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      dian_status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'not_applicable',
        comment: 'not_applicable | pending | sending | accepted | rejected',
      },
      dian_response: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      dian_sent_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      dian_accepted_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      dian_error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex('purchase_support_document_adjustments', ['tenant_id']);
    await queryInterface.addIndex('purchase_support_document_adjustments', ['purchase_id']);

    console.log('[Migration] purchase_support_document_adjustments creada');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('purchase_support_document_adjustments');
  },
};
