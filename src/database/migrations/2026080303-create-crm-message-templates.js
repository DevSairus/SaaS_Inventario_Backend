'use strict';

// CRM Fase B.3 — plantillas de mensaje reutilizables (WhatsApp/seguimientos),
// con variables {{cliente}}/{{asesor}}/{{monto}} resueltas en el backend.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('crm_message_templates')) return; // guard: ya existe

    await queryInterface.createTable('crm_message_templates', {
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
      name: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      channel: {
        type: Sequelize.ENUM('whatsapp', 'llamada', 'email'),
        allowNull: false,
        defaultValue: 'whatsapp',
      },
      body: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('crm_message_templates', ['tenant_id', 'channel'], {
      name: 'crm_message_templates_tenant_channel_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('crm_message_templates');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_message_templates_channel";');
  },
};
