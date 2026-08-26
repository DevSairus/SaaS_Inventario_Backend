'use strict';

// WhatsApp Cloud API + coexistencia — campos en meta_config / tenant_meta_configs
// y tablas wa_conversations / wa_messages (schema-per-tenant vía migrator).

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const metaDesc = await queryInterface.describeTable('meta_config').catch(() => null);
    if (metaDesc && !metaDesc.embedded_signup_config_id) {
      await queryInterface.addColumn('meta_config', 'embedded_signup_config_id', {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Config ID de Embedded Signup (FB JS SDK) para coexistencia / Tech Provider',
      });
    }

    const tenantDesc = await queryInterface.describeTable('tenant_meta_configs').catch(() => null);
    if (tenantDesc) {
      if (!tenantDesc.own_display_phone) {
        await queryInterface.addColumn('tenant_meta_configs', 'own_display_phone', {
          type: Sequelize.STRING(32),
          allowNull: true,
        });
      }
      if (!tenantDesc.wa_coexistence) {
        await queryInterface.addColumn('tenant_meta_configs', 'wa_coexistence', {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        });
      }
      if (!tenantDesc.last_wa_message_at) {
        await queryInterface.addColumn('tenant_meta_configs', 'last_wa_message_at', {
          type: Sequelize.DATE,
          allowNull: true,
        });
      }
      if (!tenantDesc.wa_history_synced_at) {
        await queryInterface.addColumn('tenant_meta_configs', 'wa_history_synced_at', {
          type: Sequelize.DATE,
          allowNull: true,
        });
      }
    }

    try {
      await queryInterface.addIndex('tenant_meta_configs', ['own_phone_number_id'], {
        name: 'tenant_meta_configs_phone_number_id_idx',
      });
    } catch (_) { /* ya existe */ }

    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

    if (!tableNames.includes('wa_conversations')) {
      await queryInterface.createTable('wa_conversations', {
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
        wa_contact_phone: { type: Sequelize.STRING(32), allowNull: false },
        wa_contact_name: { type: Sequelize.STRING(255), allowNull: true },
        assigned_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        status: {
          type: Sequelize.STRING(20),
          allowNull: false,
          defaultValue: 'open',
        },
        last_message_at: { type: Sequelize.DATE, allowNull: true },
        last_inbound_at: { type: Sequelize.DATE, allowNull: true },
        unread_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        ai_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('wa_conversations', ['tenant_id', 'wa_contact_phone'], {
        unique: true,
        name: 'wa_conversations_tenant_phone_uidx',
      });
      await queryInterface.addIndex('wa_conversations', ['tenant_id', 'assigned_user_id'], {
        name: 'wa_conversations_tenant_assignee_idx',
      });
      await queryInterface.addIndex('wa_conversations', ['tenant_id', 'last_message_at'], {
        name: 'wa_conversations_tenant_last_msg_idx',
      });
    }

    if (!tableNames.includes('wa_messages')) {
      await queryInterface.createTable('wa_messages', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenant_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' },
          onDelete: 'CASCADE',
        },
        conversation_id: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'wa_conversations', key: 'id' },
          onDelete: 'CASCADE',
        },
        direction: { type: Sequelize.STRING(10), allowNull: false },
        type: { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'text' },
        body: { type: Sequelize.TEXT, allowNull: true },
        media_url: { type: Sequelize.TEXT, allowNull: true },
        meta_message_id: { type: Sequelize.STRING(128), allowNull: true },
        status: { type: Sequelize.STRING(20), allowNull: true },
        sent_by_user_id: {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: { tableName: 'users', schema: 'public' }, key: 'id' },
          onDelete: 'SET NULL',
        },
        source: { type: Sequelize.STRING(30), allowNull: false, defaultValue: 'api' },
        raw_payload: { type: Sequelize.JSONB, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('wa_messages', ['tenant_id', 'conversation_id', 'created_at'], {
        name: 'wa_messages_conv_created_idx',
      });
      await queryInterface.addIndex('wa_messages', ['meta_message_id'], {
        name: 'wa_messages_meta_id_idx',
      });
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('wa_messages').catch(() => {});
    await queryInterface.dropTable('wa_conversations').catch(() => {});
    await queryInterface.removeColumn('tenant_meta_configs', 'wa_history_synced_at').catch(() => {});
    await queryInterface.removeColumn('tenant_meta_configs', 'last_wa_message_at').catch(() => {});
    await queryInterface.removeColumn('tenant_meta_configs', 'wa_coexistence').catch(() => {});
    await queryInterface.removeColumn('tenant_meta_configs', 'own_display_phone').catch(() => {});
    await queryInterface.removeColumn('meta_config', 'embedded_signup_config_id').catch(() => {});
  },
};
