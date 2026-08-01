'use strict';

// CRM Fase B.4 — etapas de pipeline configurables por tenant. Reemplaza el
// ENUM fijo de opportunities.stage (ver 2026080304-alter-opportunities-stage-columns.js
// y 2026080305-seed-crm-pipeline-defaults.js, que siembran los defaults
// actuales para no dejar huérfanas las oportunidades existentes).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('crm_pipeline_stages')) return; // guard: ya existe

    await queryInterface.createTable('crm_pipeline_stages', {
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
      key: {
        type: Sequelize.STRING(50),
        allowNull: false,
      },
      label: {
        type: Sequelize.STRING(100),
        allowNull: false,
      },
      color: {
        type: Sequelize.STRING(20),
        allowNull: true,
      },
      sort_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      stage_type: {
        type: Sequelize.ENUM('open', 'won', 'lost'),
        allowNull: false,
        defaultValue: 'open',
      },
      default_probability: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: '0-100, usado por el forecast (B.1) cuando la oportunidad no trae probability propia',
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('crm_pipeline_stages', ['tenant_id', 'key'], {
      name: 'crm_pipeline_stages_tenant_key_uq', unique: true,
    });
    await queryInterface.addIndex('crm_pipeline_stages', ['tenant_id', 'sort_order'], {
      name: 'crm_pipeline_stages_tenant_order_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('crm_pipeline_stages');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_crm_pipeline_stages_stage_type";');
  },
};
