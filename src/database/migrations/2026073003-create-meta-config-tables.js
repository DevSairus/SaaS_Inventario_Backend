'use strict';

// Integración con Meta (Facebook/Instagram Lead Ads hoy, WhatsApp Business
// Cloud API en fase posterior) -- ver src/models/payments/MetaConfig.js y
// TenantMetaConfig.js. meta_config es un singleton (la App de Meta que
// Pitbox registró); tenant_meta_configs guarda, por tenant, si conectó su
// propia cuenta de Meta o usa el servicio compartido de Pitbox.
// Mismo patrón que 2026071501-create-ncf-config-tables.js.

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('meta_config', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      app_id: { type: Sequelize.STRING(100), allowNull: true },
      app_secret: { type: Sequelize.TEXT, allowNull: true },
      webhook_verify_token: { type: Sequelize.STRING(255), allowNull: true },
      shared_page_id: { type: Sequelize.STRING(100), allowNull: true },
      shared_waba_id: { type: Sequelize.STRING(100), allowNull: true },
      shared_system_user_token: { type: Sequelize.TEXT, allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      last_test_at: { type: Sequelize.DATE, allowNull: true },
      last_test_ok: { type: Sequelize.BOOLEAN, allowNull: true },
      last_test_message: { type: Sequelize.STRING(500), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.createTable('tenant_meta_configs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenant_id: {
        type: Sequelize.UUID, allowNull: false, unique: true,
        references: { model: { tableName: 'tenants', schema: 'public' }, key: 'id' }, onDelete: 'CASCADE',
      },
      provider_mode: { type: Sequelize.ENUM('own', 'pitbox'), allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },

      own_app_id: { type: Sequelize.STRING(100), allowNull: true },
      own_page_id: { type: Sequelize.STRING(100), allowNull: true },
      own_page_name: { type: Sequelize.STRING(255), allowNull: true },
      own_waba_id: { type: Sequelize.STRING(100), allowNull: true },
      own_phone_number_id: { type: Sequelize.STRING(100), allowNull: true },
      own_access_token: { type: Sequelize.TEXT, allowNull: true },
      own_token_expires_at: { type: Sequelize.DATE, allowNull: true },

      pitbox_lead_form_ids: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      pitbox_external_ref: { type: Sequelize.STRING(150), allowNull: true },

      connected_at: { type: Sequelize.DATE, allowNull: true },
      disconnected_at: { type: Sequelize.DATE, allowNull: true },
      last_lead_at: { type: Sequelize.DATE, allowNull: true },
      last_error: { type: Sequelize.STRING(500), allowNull: true },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    // GIN sobre el JSONB de form IDs -- es por acá que el webhook resuelve
    // a qué tenant pertenece un lead en modo "pitbox" (ver metaWebhook.controller.js)
    await queryInterface.addIndex('tenant_meta_configs', ['pitbox_lead_form_ids'], {
      using: 'gin',
      name: 'tenant_meta_configs_lead_form_ids_gin',
    });
    await queryInterface.addIndex('tenant_meta_configs', ['own_page_id']);
    await queryInterface.addIndex('tenant_meta_configs', ['own_waba_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('tenant_meta_configs');
    await queryInterface.dropTable('meta_config');
  },
};
