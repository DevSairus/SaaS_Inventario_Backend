'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable('support_faq_categories', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        name: { type: Sequelize.STRING(150), allowNull: false },
        order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });

      await queryInterface.createTable('support_faq_articles', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        category_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'support_faq_categories', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        question: { type: Sequelize.STRING(500), allowNull: false },
        answer: { type: Sequelize.TEXT, allowNull: false },
        order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        helpful_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        not_helpful_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('support_faq_articles', ['category_id'], { transaction });

      await queryInterface.createTable('support_tickets', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        created_by: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        },
        subject: { type: Sequelize.STRING(255), allowNull: false },
        category: { type: Sequelize.STRING(100), allowNull: true },
        priority: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'medium',
          comment: 'low | medium | high | urgent',
        },
        status: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'open',
          comment: 'open | in_progress | waiting_customer | resolved | closed',
        },
        assigned_agent_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        },
        first_response_at: { type: Sequelize.DATE, allowNull: true },
        resolved_at: { type: Sequelize.DATE, allowNull: true },
        closed_at: { type: Sequelize.DATE, allowNull: true },
        rating: { type: Sequelize.INTEGER, allowNull: true },
        sla_due_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('support_tickets', ['tenant_id'], { transaction });
      await queryInterface.addIndex('support_tickets', ['status'], { transaction });
      await queryInterface.addIndex('support_tickets', ['assigned_agent_id'], { transaction });
      await queryInterface.addIndex('support_tickets', ['created_by'], { transaction });

      await queryInterface.createTable('support_ticket_messages', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        ticket_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'support_tickets', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        author_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        },
        is_internal_note: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        message: { type: Sequelize.TEXT, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('support_ticket_messages', ['ticket_id'], { transaction });

      await queryInterface.createTable('support_ticket_attachments', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        ticket_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'support_tickets', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        message_id: {
          type: Sequelize.UUID, allowNull: true,
          references: { model: 'support_ticket_messages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        file_url: { type: Sequelize.STRING(500), allowNull: false },
        file_name: { type: Sequelize.STRING(255), allowNull: false },
        mime_type: { type: Sequelize.STRING(100), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('support_ticket_attachments', ['ticket_id'], { transaction });
      await queryInterface.addIndex('support_ticket_attachments', ['message_id'], { transaction });

      await queryInterface.createTable('remote_support_sessions', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        ticket_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: 'support_tickets', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        agent_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        },
        tenant_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        user_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
        },
        mode: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'view_only',
          comment: 'view_only | remote_control',
        },
        started_at: { type: Sequelize.DATE, allowNull: true },
        ended_at: { type: Sequelize.DATE, allowNull: true },
        consent_given_at: { type: Sequelize.DATE, allowNull: true },
        consent_scope: {
          type: Sequelize.STRING(20), allowNull: true,
          comment: 'view_only | remote_control',
        },
        status: {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending',
          comment: 'pending | active | ended | rejected | expired',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      }, { transaction });
      await queryInterface.addIndex('remote_support_sessions', ['ticket_id'], { transaction });
      await queryInterface.addIndex('remote_support_sessions', ['tenant_id'], { transaction });
      await queryInterface.addIndex('remote_support_sessions', ['status'], { transaction });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('remote_support_sessions');
    await queryInterface.dropTable('support_ticket_attachments');
    await queryInterface.dropTable('support_ticket_messages');
    await queryInterface.dropTable('support_tickets');
    await queryInterface.dropTable('support_faq_articles');
    await queryInterface.dropTable('support_faq_categories');
  },
};
