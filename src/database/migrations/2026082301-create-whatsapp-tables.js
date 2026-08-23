'use strict';

// Tablas del módulo de WhatsApp (campañas, conversaciones/mensajes, recordatorios
// y catálogo de templates). Existían en `public` desde antes de la migración a
// schema-per-tenant, pero NUNCA tuvieron un archivo de migración propio en este
// repo (se crearon a mano / desde otro proceso) -- así que provisionTenantSchema.js
// nunca las creaba en los schemas nuevos de tenant, y el cutover reventaba con
// "relation ... does not exist" al intentar copiar/limpiar filas de ellas
// (ver tenantScopedTables.js, que las descubre automáticamente por tener
// tenant_id propio).
//
// La estructura de cada tabla se tomó por introspección directa de la base de
// producción (information_schema + pg_indexes), columna por columna, para que
// el schema de tenant quede idéntico al de `public`.
//
// Guard por tabla: en `public` las 6 tablas ya existen con datos reales -> si
// esta migración corriera ahí (deploy normal), NO debe intentar recrearlas.
// En un schema de tenant nuevo (provisionTenantSchema.js) no existen todavía
// -> ahí sí se crean.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const existing = new Set(await queryInterface.showAllTables());

    if (!existing.has('wa_campaigns')) {
      await queryInterface.createTable('wa_campaigns', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
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
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('wa_campaigns', ['tenant_id', 'status'], {
        name: 'wa_campaigns_tenant_status_idx',
      });
    }

    if (!existing.has('wa_campaign_recipients')) {
      await queryInterface.createTable('wa_campaign_recipients', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
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
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('wa_campaign_recipients', ['campaign_id', 'status'], {
        name: 'wa_campaign_recipients_status_idx',
      });
    }

    if (!existing.has('wa_conversations')) {
      await queryInterface.createTable('wa_conversations', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
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
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'open' },
        last_message_at: { type: Sequelize.DATE, allowNull: true },
        last_inbound_at: { type: Sequelize.DATE, allowNull: true },
        unread_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        ai_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
        is_pinned: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        priority: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'normal' },
        follow_up_at: { type: Sequelize.DATE, allowNull: true },
        marks: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        internal_note: { type: Sequelize.TEXT, allowNull: true },
      });
      await queryInterface.addIndex('wa_conversations', ['tenant_id', 'wa_contact_phone'], {
        name: 'wa_conversations_tenant_phone_uidx',
        unique: true,
      });
      await queryInterface.addIndex('wa_conversations', ['tenant_id', 'assigned_user_id'], {
        name: 'wa_conversations_tenant_assignee_idx',
      });
      await queryInterface.addIndex('wa_conversations', ['tenant_id', 'last_message_at'], {
        name: 'wa_conversations_tenant_last_msg_idx',
      });
    }

    if (!existing.has('wa_messages')) {
      await queryInterface.createTable('wa_messages', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
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
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('wa_messages', ['tenant_id', 'conversation_id', 'created_at'], {
        name: 'wa_messages_conv_created_idx',
      });
      await queryInterface.addIndex('wa_messages', ['meta_message_id'], {
        name: 'wa_messages_meta_id_idx',
      });
    }

    if (!existing.has('wa_reminder_jobs')) {
      await queryInterface.createTable('wa_reminder_jobs', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
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
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('wa_reminder_jobs', ['tenant_id', 'status', 'scheduled_at'], {
        name: 'wa_reminder_jobs_due_idx',
      });
    }

    if (!existing.has('wa_templates')) {
      await queryInterface.createTable('wa_templates', {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
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
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('wa_templates', ['tenant_id', 'name', 'language'], {
        name: 'wa_templates_tenant_name_lang_uidx',
        unique: true,
      });
    }
  },

  // No-op deliberado: en `public` estas 6 tablas ya existían ANTES de esta
  // migración, con datos reales de producción (mensajes, conversaciones,
  // campañas). Esta migración no las creó ahí (ver guard en `up`), así que
  // revertirla ahí no debería destruirlas. Si hace falta deshacer el
  // aprovisionamiento de un schema de tenant nuevo, se descarta el schema
  // completo (`DROP SCHEMA ... CASCADE`), no se corre `down` de migraciones
  // individuales -- mismo criterio que el resto de scripts de cutover.
  down: async () => {},
};
