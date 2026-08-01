'use strict';

// CRM Fase 1 — bitácora de contacto con el cliente (llamada, WhatsApp,
// visita, email, nota interna). Alimenta la vista 360° del cliente y
// desnormaliza `customers.last_interaction_at`.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('customer_interactions')) return; // guard: ya existe

    await queryInterface.createTable('customer_interactions', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
        onDelete: 'CASCADE',
      },
      branch_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onDelete: 'SET NULL',
      },
      customer_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'customers', key: 'id' },
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
        onDelete: 'SET NULL',
        comment: 'Quién registró la interacción (null si fue automática del sistema)',
      },
      type: {
        type: Sequelize.ENUM('llamada', 'whatsapp', 'email', 'visita', 'nota', 'reunion'),
        allowNull: false,
      },
      channel_ref: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'id de mensaje WPPConnect u otra referencia externa, si aplica',
      },
      summary: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      outcome: {
        type: Sequelize.ENUM('positivo', 'neutral', 'negativo', 'sin_respuesta'),
        allowNull: true,
      },
      follow_up_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Si se define, dispara un recordatorio de seguimiento',
      },
      related_sale_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'sales', key: 'id' },
        onDelete: 'SET NULL',
      },
      related_work_order_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'work_orders', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('customer_interactions', ['tenant_id', 'customer_id'], {
      name: 'customer_interactions_tenant_customer_idx',
    });
    await queryInterface.addIndex('customer_interactions', ['tenant_id', 'user_id'], {
      name: 'customer_interactions_tenant_user_idx',
    });
    await queryInterface.addIndex('customer_interactions', ['tenant_id', 'follow_up_at'], {
      name: 'customer_interactions_tenant_followup_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('customer_interactions');
  },
};