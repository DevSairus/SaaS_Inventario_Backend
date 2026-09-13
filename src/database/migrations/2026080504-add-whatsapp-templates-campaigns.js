'use strict';

// Fase 3 WhatsApp: plantillas Meta, recordatorios y campañas.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

    if (!tableNames.includes('wa_templates')) {
      await queryInterface.createTable('wa_templates', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        name: { type: Sequelize.STRING(512), allowNull: false },
        language: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'es' },
        status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'PENDING' },
        category: { type: Sequelize.STRING(32), allowNull: true },
        components_schema: { type: Sequelize.JSONB, allowNull: true },
        meta_template_id: { type: Sequelize.STRING(64), allowNull: true },
        last_synced_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('wa_templates', ['tenant_id', 'name', 'language'], {
        unique: true,
        name: 'wa_templates_tenant_name_lang_uidx',
      });
    }

    if (!tableNames.includes('wa_reminder_jobs')) {
      await queryInterface.createTable('wa_reminder_jobs', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        customer_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'customers', key: 'id' },
          onDelete: 'SET NULL',
        },
        phone: { type: Sequelize.STRING(32), allowNull: false },
        template_name: { type: Sequelize.STRING(512), allowNull: false },
        language: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'es' },
        components: { type: Sequelize.JSONB, allowNull: true },
        scheduled_at: { type: Sequelize.DATE, allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
        error_message: { type: Sequelize.TEXT, allowNull: true },
        sent_at: { type: Sequelize.DATE, allowNull: true },
        created_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('wa_reminder_jobs', ['tenant_id', 'status', 'scheduled_at'], {
        name: 'wa_reminder_jobs_due_idx',
      });
    }

    if (!tableNames.includes('wa_campaigns')) {
      await queryInterface.createTable('wa_campaigns', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        name: { type: Sequelize.STRING(255), allowNull: false },
        template_name: { type: Sequelize.STRING(512), allowNull: false },
        language: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'es' },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'draft' },
        audience_filter: { type: Sequelize.JSONB, allowNull: true },
        sent_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        failed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        total_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        started_at: { type: Sequelize.DATE, allowNull: true },
        finished_at: { type: Sequelize.DATE, allowNull: true },
        created_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('wa_campaigns', ['tenant_id', 'status'], {
        name: 'wa_campaigns_tenant_status_idx',
      });
    }

    if (!tableNames.includes('wa_campaign_recipients')) {
      await queryInterface.createTable('wa_campaign_recipients', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        campaign_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'wa_campaigns', key: 'id' },
          onDelete: 'CASCADE',
        },
        customer_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: 'customers', key: 'id' },
          onDelete: 'SET NULL',
        },
        phone: { type: Sequelize.STRING(32), allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
        error_message: { type: Sequelize.TEXT, allowNull: true },
        meta_message_id: { type: Sequelize.STRING(128), allowNull: true },
        sent_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('wa_campaign_recipients', ['campaign_id', 'status'], {
        name: 'wa_campaign_recipients_status_idx',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('wa_campaign_recipients').catch(() => {});
    await queryInterface.dropTable('wa_campaigns').catch(() => {});
    await queryInterface.dropTable('wa_reminder_jobs').catch(() => {});
    await queryInterface.dropTable('wa_templates').catch(() => {});
  },
};
